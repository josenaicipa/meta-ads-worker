const META_API_VERSION = 'v21.0';
const META_BASE = `https://graph.facebook.com/${META_API_VERSION}`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') return corsOk();

    const secret = request.headers.get('x-api-secret') || url.searchParams.get('secret');
    if (!env.META_API_SECRET || secret !== env.META_API_SECRET) {
      return json({ error: 'Unauthorized' }, 401);
    }

    const token = env.META_ACCESS_TOKEN;
    if (!token) return json({ error: 'META_ACCESS_TOKEN not configured.' }, 500);

    if (request.method === 'GET') {
      if (path === '/campaigns') return handleCampaigns(url, token, env.META_AD_ACCOUNT_ID);
      if (path === '/accounts') return handleAllAccounts(url, token);
      if (path === '/daily') return handleDaily(url, token, env.META_AD_ACCOUNT_ID);
    }

    if (request.method === 'POST') {
      if (path === '/adset/update') return handleAdsetUpdate(request, token);
    }

    return json({ error: 'Not found. Use GET /campaigns, GET /accounts, or POST /adset/update' }, 404);
  },
};

async function handleCampaigns(url, token, defaultAccountId) {
  const datePreset = url.searchParams.get('date_preset') || 'last_7d';
  const level = url.searchParams.get('level') || 'campaign';
  const accountId = url.searchParams.get('account_id') || defaultAccountId;

  if (!accountId) return json({ error: 'No account_id provided.' }, 400);

  try {
    const accountInfo = await metaGet(`${accountId}`, {
      fields: 'name,account_status,currency,balance',
    }, token);

    const insights = await metaGet(`${accountId}/insights`, {
      fields: 'campaign_name,campaign_id,adset_name,adset_id,impressions,clicks,spend,cpm,cpc,ctr,actions,cost_per_action_type,purchase_roas,reach,frequency',
      date_preset: datePreset,
      level,
      limit: '50',
      sort: 'spend_descending',
    }, token);

    const campaigns = await metaGet(`${accountId}/campaigns`, {
      fields: 'name,status,objective,daily_budget,lifetime_budget,budget_remaining',
      filtering: JSON.stringify([{ field: 'effective_status', operator: 'IN', value: ['ACTIVE', 'PAUSED'] }]),
      limit: '50',
    }, token);

    const processed = (insights.data || []).map(parseInsightRow);
    const totalSpend = processed.reduce((s, r) => s + r.spend, 0);
    const totalPurchases = processed.reduce((s, r) => s + r.purchases, 0);
    const totalRevenue = processed.reduce((s, r) => s + (r.spend * r.roas), 0);

    return json({
      account: {
        id: accountId,
        name: accountInfo.name,
        status: accountInfo.account_status === 1 ? 'ACTIVE' : 'INACTIVE',
        currency: accountInfo.currency,
      },
      period: datePreset,
      level,
      summary: {
        total_spend: round2(totalSpend),
        total_purchases: totalPurchases,
        total_revenue_estimated: round2(totalRevenue),
        avg_cpa: totalPurchases > 0 ? round2(totalSpend / totalPurchases) : null,
        avg_roas: totalSpend > 0 ? round2(totalRevenue / totalSpend) : null,
      },
      campaigns: (campaigns.data || []).map(c => ({
        name: c.name,
        status: c.status,
        objective: c.objective,
        daily_budget: c.daily_budget ? parseFloat(c.daily_budget) / 100 : null,
        lifetime_budget: c.lifetime_budget ? parseFloat(c.lifetime_budget) / 100 : null,
        budget_remaining: c.budget_remaining ? parseFloat(c.budget_remaining) / 100 : null,
      })),
      insights: processed,
    });
  } catch (err) {
    return json({ error: err.message || 'Error fetching campaign data' }, 500);
  }
}

async function handleDaily(url, token, defaultAccountId) {
  const datePreset = url.searchParams.get('date_preset') || 'last_7d';
  const level = url.searchParams.get('level') || 'campaign';
  const accountId = url.searchParams.get('account_id') || defaultAccountId;

  if (!accountId) return json({ error: 'No account_id provided.' }, 400);

  try {
    const accountInfo = await metaGet(`${accountId}`, {
      fields: 'name,account_status,currency',
    }, token);

    const insights = await metaGet(`${accountId}/insights`, {
      fields: 'campaign_name,campaign_id,adset_name,adset_id,impressions,clicks,spend,cpm,cpc,ctr,actions,cost_per_action_type,purchase_roas,reach,frequency',
      date_preset: datePreset,
      level,
      time_increment: '1',
      limit: '200',
      sort: 'date_start_ascending',
    }, token);

    const rows = (insights.data || []).map(row => ({
      date: row.date_start,
      ...parseInsightRow(row),
    }));

    const byDate = {};
    for (const row of rows) {
      if (!byDate[row.date]) {
        byDate[row.date] = { date: row.date, spend: 0, impressions: 0, clicks: 0, purchases: 0, leads: 0, initiate_checkout: 0, revenue: 0, details: [] };
      }
      const d = byDate[row.date];
      d.spend += row.spend;
      d.impressions += row.impressions;
      d.clicks += row.clicks;
      d.purchases += row.purchases;
      d.leads += row.leads;
      d.initiate_checkout += row.initiate_checkout;
      d.revenue += row.spend * row.roas;
      d.details.push(row);
    }

    const daily = Object.values(byDate).map(d => ({
      ...d,
      spend: round2(d.spend),
      revenue: round2(d.revenue),
      cpa: d.purchases > 0 ? round2(d.spend / d.purchases) : null,
      roas: d.spend > 0 ? round2(d.revenue / d.spend) : null,
    }));

    return json({
      account: { id: accountId, name: accountInfo.name },
      period: datePreset,
      level,
      daily,
    });
  } catch (err) {
    return json({ error: err.message || 'Error fetching daily data' }, 500);
  }
}

async function handleAllAccounts(url, token) {
  const datePreset = url.searchParams.get('date_preset') || 'last_7d';

  try {
    const accounts = await metaGet('me/adaccounts', {
      fields: 'id,name,account_status,currency',
      limit: '50',
    }, token);

    const results = [];
    let grandSpend = 0, grandPurchases = 0, grandRevenue = 0;

    for (const acct of (accounts.data || [])) {
      let spend = 0, purchases = 0, roas = 0, impressions = 0;
      try {
        const ins = await metaGet(`${acct.id}/insights`, {
          fields: 'spend,impressions,actions,purchase_roas',
          date_preset: datePreset,
          limit: '1',
        }, token);
        const row = (ins.data || [])[0] || {};
        spend = parseFloat(row.spend || 0);
        impressions = parseInt(row.impressions || 0);
        purchases = findAction(row.actions, 'purchase');
        roas = findRoas(row.purchase_roas);
      } catch { /* no data for this account */ }

      grandSpend += spend;
      grandPurchases += purchases;
      grandRevenue += spend * roas;

      results.push({
        id: acct.id,
        name: acct.name,
        status: acct.account_status === 1 ? 'ACTIVE' : 'INACTIVE',
        currency: acct.currency,
        spend: round2(spend),
        impressions,
        purchases,
        cpa: purchases > 0 ? round2(spend / purchases) : null,
        roas: round2(roas),
      });
    }

    return json({
      period: datePreset,
      total_accounts: results.length,
      summary: {
        total_spend: round2(grandSpend),
        total_purchases: grandPurchases,
        total_revenue_estimated: round2(grandRevenue),
        avg_cpa: grandPurchases > 0 ? round2(grandSpend / grandPurchases) : null,
        avg_roas: grandSpend > 0 ? round2(grandRevenue / grandSpend) : null,
      },
      accounts: results,
    });
  } catch (err) {
    return json({ error: err.message || 'Error fetching accounts' }, 500);
  }
}

async function handleAdsetUpdate(request, token) {
  try {
    const body = await request.json();
    const { adset_id, status, daily_budget } = body;

    if (!adset_id) return json({ error: 'adset_id is required' }, 400);

    const params = {};
    if (status) params.status = status; // ACTIVE, PAUSED
    if (daily_budget) params.daily_budget = daily_budget; // in cents

    if (Object.keys(params).length === 0) {
      return json({ error: 'Provide status and/or daily_budget' }, 400);
    }

    const qs = new URLSearchParams(params);
    qs.append('access_token', token);

    const res = await fetch(`${META_BASE}/${adset_id}?${qs.toString()}`, {
      method: 'POST',
    });
    const data = await res.json();

    if (data.error) {
      return json({ error: data.error.message, code: data.error.code }, 400);
    }

    return json({
      success: true,
      adset_id,
      updates: params,
      result: data,
    });
  } catch (err) {
    return json({ error: err.message || 'Error updating ad set' }, 500);
  }
}

function parseInsightRow(row) {
  return {
    campaign_name: row.campaign_name,
    campaign_id: row.campaign_id,
    adset_name: row.adset_name || null,
    adset_id: row.adset_id || null,
    spend: parseFloat(row.spend || 0),
    impressions: parseInt(row.impressions || 0),
    reach: parseInt(row.reach || 0),
    clicks: parseInt(row.clicks || 0),
    cpm: parseFloat(row.cpm || 0),
    cpc: parseFloat(row.cpc || 0),
    ctr: parseFloat(row.ctr || 0),
    frequency: parseFloat(row.frequency || 0),
    purchases: findAction(row.actions, 'purchase'),
    leads: findAction(row.actions, 'lead'),
    initiate_checkout: findAction(row.actions, 'initiate_checkout'),
    add_to_cart: findAction(row.actions, 'add_to_cart'),
    cost_per_purchase: findAction(row.cost_per_action_type, 'purchase', true),
    roas: findRoas(row.purchase_roas),
  };
}

function findAction(actions, type, isFloat = false) {
  const a = (actions || []).find(x => x.action_type === type);
  if (!a) return 0;
  return isFloat ? parseFloat(a.value || 0) : parseInt(a.value || 0);
}

function findRoas(roasArr) {
  const a = (roasArr || []).find(x => x.action_type === 'omni_purchase');
  return a ? parseFloat(a.value || 0) : 0;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

async function metaGet(endpoint, params, token) {
  const qs = new URLSearchParams(params);
  qs.append('access_token', token);
  const res = await fetch(`${META_BASE}/${endpoint}?${qs.toString()}`);
  const data = await res.json();
  if (data.error) throw new Error(`${data.error.message} (code ${data.error.code})`);
  return data;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function corsOk() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-api-secret',
    },
  });
}
