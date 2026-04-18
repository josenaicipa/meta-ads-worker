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
      if (path === '/adset') return handleAdsetInfo(url, token);
      if (path === '/adset/ads') return handleAdsetAds(url, token);
      if (path === '/adset/targeting') return handleAdsetTargeting(url, token);
    }

    if (request.method === 'POST') {
      if (path === '/adset/update') return handleAdsetUpdate(request, token);
      if (path === '/campaign/create') return handleCampaignCreate(request, token, env.META_AD_ACCOUNT_ID);
      if (path === '/adset/create') return handleAdsetCreate(request, token, env.META_AD_ACCOUNT_ID);
      if (path === '/ad/create') return handleAdCreate(request, token, env.META_AD_ACCOUNT_ID);
    }

    return json({
      error: 'Not found',
      endpoints: {
        GET: ['/campaigns', '/accounts', '/daily', '/adset', '/adset/ads', '/adset/targeting'],
        POST: ['/adset/update', '/campaign/create', '/adset/create', '/ad/create'],
      },
    }, 404);
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

async function handleAdsetInfo(url, token) {
  const adsetId = url.searchParams.get('adset_id');
  if (!adsetId) return json({ error: 'adset_id is required' }, 400);

  try {
    const data = await metaGet(adsetId, {
      fields: 'name,status,daily_budget,lifetime_budget,budget_remaining,targeting,optimization_goal',
    }, token);

    return json({
      adset_id: adsetId,
      name: data.name,
      status: data.status,
      daily_budget: data.daily_budget ? parseFloat(data.daily_budget) / 100 : null,
      daily_budget_cents: data.daily_budget ? parseInt(data.daily_budget) : null,
      lifetime_budget: data.lifetime_budget ? parseFloat(data.lifetime_budget) / 100 : null,
      budget_remaining: data.budget_remaining ? parseFloat(data.budget_remaining) / 100 : null,
      optimization_goal: data.optimization_goal,
    });
  } catch (err) {
    return json({ error: err.message || 'Error fetching ad set info' }, 500);
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

async function handleAdsetAds(url, token) {
  const adsetId = url.searchParams.get('adset_id');
  if (!adsetId) return json({ error: 'adset_id is required' }, 400);

  try {
    const data = await metaGet(`${adsetId}/ads`, {
      fields: 'id,name,status,creative{id,name,body,title,link_url,image_url,video_id,object_story_id,effective_object_story_id}',
      limit: '50',
    }, token);

    return json({
      adset_id: adsetId,
      ads: (data.data || []).map(ad => ({
        id: ad.id,
        name: ad.name,
        status: ad.status,
        creative: ad.creative || null,
      })),
    });
  } catch (err) {
    return json({ error: err.message || 'Error fetching ads' }, 500);
  }
}

async function handleAdsetTargeting(url, token) {
  const adsetId = url.searchParams.get('adset_id');
  if (!adsetId) return json({ error: 'adset_id is required' }, 400);

  try {
    const data = await metaGet(adsetId, {
      fields: 'name,targeting,promoted_object,optimization_goal,billing_event,bid_strategy,daily_budget,status',
    }, token);

    return json({
      adset_id: adsetId,
      name: data.name,
      status: data.status,
      optimization_goal: data.optimization_goal,
      billing_event: data.billing_event,
      bid_strategy: data.bid_strategy,
      daily_budget: data.daily_budget ? parseFloat(data.daily_budget) / 100 : null,
      targeting: data.targeting,
      promoted_object: data.promoted_object,
    });
  } catch (err) {
    return json({ error: err.message || 'Error fetching targeting' }, 500);
  }
}

// POST /campaign/create — creates a campaign on the default (Academia Unlocked) account
// unless account_id is overridden. Defaults to PAUSED so nothing goes live by accident.
// Example payload:
// {
//   "name": "Academia Unlocked - Ventas Abril",
//   "objective": "OUTCOME_SALES",
//   "status": "PAUSED",
//   "special_ad_categories": [],
//   "daily_budget": 5000,            // cents (optional; mutually exclusive with lifetime_budget)
//   "lifetime_budget": 50000,        // cents (optional)
//   "buying_type": "AUCTION",        // optional: AUCTION | RESERVED
//   "bid_strategy": "LOWEST_COST_WITHOUT_CAP", // optional
//   "promoted_object": { "pixel_id": "123", "custom_event_type": "PURCHASE" } // optional
// }
async function handleCampaignCreate(request, token, defaultAccountId) {
  try {
    const body = await request.json();
    const accountId = body.account_id || defaultAccountId;
    if (!accountId) return json({ error: 'account_id is required' }, 400);
    if (!body.name) return json({ error: 'name is required' }, 400);
    if (!body.objective) return json({ error: 'objective is required' }, 400);
    if (body.daily_budget && body.lifetime_budget) {
      return json({ error: 'Provide either daily_budget or lifetime_budget, not both' }, 400);
    }

    const params = {
      name: body.name,
      objective: body.objective,
      status: body.status || 'PAUSED',
      special_ad_categories: JSON.stringify(body.special_ad_categories || []),
    };

    if (body.buying_type) params.buying_type = body.buying_type;
    if (body.daily_budget) params.daily_budget = body.daily_budget;
    if (body.lifetime_budget) params.lifetime_budget = body.lifetime_budget;
    if (body.bid_strategy) params.bid_strategy = body.bid_strategy;
    if (body.promoted_object) params.promoted_object = JSON.stringify(body.promoted_object);

    const result = await metaPost(`${accountId}/campaigns`, params, token);
    return json({ success: true, campaign_id: result.id, ...result });
  } catch (err) {
    return json({ error: err.message || 'Error creating campaign' }, 500);
  }
}

async function handleAdsetCreate(request, token, defaultAccountId) {
  try {
    const body = await request.json();
    const accountId = body.account_id || defaultAccountId;
    if (!accountId) return json({ error: 'account_id is required' }, 400);
    if (!body.campaign_id) return json({ error: 'campaign_id is required' }, 400);
    if (!body.name) return json({ error: 'name is required' }, 400);

    const params = {
      name: body.name,
      campaign_id: body.campaign_id,
      status: body.status || 'PAUSED',
      optimization_goal: body.optimization_goal || 'OFFSITE_CONVERSIONS',
      billing_event: body.billing_event || 'IMPRESSIONS',
      bid_strategy: body.bid_strategy || 'LOWEST_COST_WITHOUT_CAP',
      targeting: JSON.stringify(body.targeting),
    };

    if (body.promoted_object) {
      params.promoted_object = JSON.stringify(body.promoted_object);
    }

    if (body.daily_budget) params.daily_budget = body.daily_budget;

    const result = await metaPost(`${accountId}/adsets`, params, token);
    return json({ success: true, adset_id: result.id, ...result });
  } catch (err) {
    return json({ error: err.message || 'Error creating ad set' }, 500);
  }
}

async function handleAdCreate(request, token, defaultAccountId) {
  try {
    const body = await request.json();
    const accountId = body.account_id || defaultAccountId;
    if (!accountId) return json({ error: 'account_id is required' }, 400);
    if (!body.adset_id) return json({ error: 'adset_id is required' }, 400);
    if (!body.name) return json({ error: 'name is required' }, 400);

    const params = {
      name: body.name,
      adset_id: body.adset_id,
      status: body.status || 'PAUSED',
    };

    if (body.creative_id) {
      params.creative = JSON.stringify({ creative_id: body.creative_id });
    } else if (body.object_story_id) {
      params.creative = JSON.stringify({ object_story_id: body.object_story_id });
    } else {
      return json({ error: 'creative_id or object_story_id is required' }, 400);
    }

    const result = await metaPost(`${accountId}/ads`, params, token);
    return json({ success: true, ad_id: result.id, ...result });
  } catch (err) {
    return json({ error: err.message || 'Error creating ad' }, 500);
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

async function metaPost(endpoint, params, token) {
  const qs = new URLSearchParams(params);
  qs.append('access_token', token);
  const res = await fetch(`${META_BASE}/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: qs.toString(),
  });
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
