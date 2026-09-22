import fs from 'node:fs/promises';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function creatorContext(type, id) {
  if (!id) throw new Error('ROBLOX_CREATOR_ID is missing.');
  if (String(type).toLowerCase() === 'user') return { userId: String(id) };
  return { groupId: String(id) };
}

function extractOperationId(value) {
  if (!value) return null;
  const s = String(value);
  const m = s.match(/operations\/([^/?#]+)/i);
  return m ? m[1] : s;
}

function normalizeModerationValue(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  const compact = s.toLowerCase().replace(/[\s_-]+/g, '');

  if (/(approved|accepted|allowed|passed|cleared)/.test(compact)) {
    return { status: 'approved', label: s };
  }
  if (/(declined|rejected|denied|blocked|removed)/.test(compact)) {
    return { status: 'declined', label: s };
  }
  if (/(pending|reviewing|underreview|inreview|moderating|queued|processing)/.test(compact)) {
    return { status: 'pending', label: s };
  }
  return null;
}

// Roblox has changed the exact shape of asset/moderation responses over time.
// This reader only trusts fields that are explicitly moderation/review-related;
// it never treats "asset creation succeeded" as "moderation approved".
function readModerationDecision(root) {
  const direct = [
    root?.moderationStatus,
    root?.reviewStatus,
    root?.moderationState,
    root?.moderationResult?.moderationState,
    root?.moderationResult?.state,
    root?.response?.moderationStatus,
    root?.response?.reviewStatus,
    root?.response?.moderationState,
    root?.response?.moderationResult?.moderationState,
    root?.response?.moderationResult?.state,
  ];
  for (const value of direct) {
    const result = normalizeModerationValue(value);
    if (result) return result;
  }

  const seen = new Set();
  function walk(value, moderationContext = false, depth = 0) {
    if (depth > 8 || value == null) return null;
    if (typeof value !== 'object') {
      return moderationContext ? normalizeModerationValue(value) : null;
    }
    if (seen.has(value)) return null;
    seen.add(value);

    for (const [key, child] of Object.entries(value)) {
      const k = String(key).toLowerCase();
      const childContext = moderationContext || k.includes('moderation') || k.includes('review');
      if (childContext && (typeof child === 'string' || typeof child === 'number')) {
        const result = normalizeModerationValue(child);
        if (result) return result;
      }
      const nested = walk(child, childContext, depth + 1);
      if (nested) return nested;
    }
    return null;
  }
  return walk(root);
}

export class RobloxClient {
  constructor(env) {
    this.key = env.ROBLOX_API_KEY || '';
    this.creatorType = env.ROBLOX_CREATOR_TYPE || 'group';
    this.creatorId = env.ROBLOX_CREATOR_ID || '';
    this.uploadUrl = env.ROBLOX_UPLOAD_URL || 'https://apis.roblox.com/assets/v1/assets';
    this.operationBase = (env.ROBLOX_OPERATION_BASE_URL || 'https://apis.roblox.com/assets/v1/operations').replace(/\/$/, '');
    this.assetBase = (env.ROBLOX_ASSET_BASE_URL || 'https://apis.roblox.com/assets/v1/assets').replace(/\/$/, '');
    this.statusUrlTemplate = env.ROBLOX_MODERATION_STATUS_URL_TEMPLATE || '';
    this.assetPermissionsUrl = env.ROBLOX_ASSET_PERMISSIONS_URL || 'https://apis.roblox.com/asset-permissions-api/v1/assets/permissions';
    this.estUniverseId = String(env.EST_UNIVERSE_ID || '').trim();
    this.simulate = String(env.SIMULATE_ROBLOX || '').toLowerCase() === 'true';
  }

  get configured() { return this.simulate || Boolean(this.key && this.creatorId && this.uploadUrl); }

  async uploadAudio(file, displayName, partIndex = 1) {
    if (this.simulate) {
      await sleep(500);
      return {
        assetId: String(Math.floor(100000000000000 + Math.random() * 899999999999999)),
        simulated: true,
        moderation: { status: 'approved', label: 'Simulated approval' }
      };
    }
    if (!this.key) throw new Error('ROBLOX_API_KEY is missing.');

    const bytes = await fs.readFile(file);
    const request = {
      assetType: 'Audio',
      displayName: partIndex > 1 ? `${displayName} (${partIndex})` : displayName,
      description: 'Uploaded by EST Karaoke Upload Desk',
      creationContext: { creator: creatorContext(this.creatorType, this.creatorId) }
    };
    const form = new FormData();
    form.append('request', JSON.stringify(request));
    form.append('fileContent', new Blob([bytes], { type: 'audio/mpeg' }), `audio-${partIndex}.mp3`);

    const res = await fetch(this.uploadUrl, { method: 'POST', headers: { 'x-api-key': this.key }, body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.message || data?.error || `Roblox upload failed (${res.status}).`);

    if (data?.response?.assetId || data?.assetId) {
      return {
        assetId: String(data.response?.assetId || data.assetId),
        raw: data,
        moderation: readModerationDecision(data) || { status: 'pending', label: 'Pending review' }
      };
    }

    const opId = extractOperationId(data?.path || data?.operationId || data?.name);
    if (!opId) throw new Error('Roblox accepted the upload but returned an unrecognized operation response. Check ROBLOX_* API settings against current Open Cloud docs.');
    return this.waitForOperation(opId);
  }

  async getOperation(operationId) {
    const res = await fetch(`${this.operationBase}/${encodeURIComponent(operationId)}`, {
      headers: { 'x-api-key': this.key }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.message || data?.error || `Roblox operation check failed (${res.status}).`);
    return data;
  }

  async waitForOperation(operationId) {
    for (let attempt = 0; attempt < 90; attempt++) {
      const data = await this.getOperation(operationId);
      const assetId = data?.response?.assetId || data?.assetId;
      if (data?.done && assetId) {
        return {
          assetId: String(assetId),
          operationId: String(operationId),
          raw: data,
          moderation: readModerationDecision(data) || { status: 'pending', label: 'Pending review' }
        };
      }
      if (data?.done && data?.error) throw new Error(data.error.message || 'Roblox asset operation failed.');
      await sleep(2000);
    }
    throw new Error('Timed out waiting for Roblox asset creation.');
  }

  async grantUniverseUsePermission(assetId, universeId = this.estUniverseId) {
    if (this.simulate) {
      return { ok: true, simulated: true, status: 200 };
    }
    if (!this.key) throw new Error('ROBLOX_API_KEY is missing.');
    if (!assetId) throw new Error('Cannot grant KTV access: asset ID is missing.');
    if (!universeId) throw new Error('EST_UNIVERSE_ID is missing.');

    // Roblox Open Cloud Asset Permissions API expects assetId as an int64 JSON number.
    // Roblox asset IDs currently used here are within JavaScript's safe-integer range.
    const numericAssetId = Number(assetId);
    if (!Number.isSafeInteger(numericAssetId) || numericAssetId <= 0) {
      throw new Error(`Cannot grant KTV access: invalid asset ID ${assetId}.`);
    }

    const body = {
      subjectType: 'Universe',
      subjectId: String(universeId),
      action: 'Use',
      requests: [
        {
          assetId: numericAssetId
        }
      ]
    };

    const res = await fetch(this.assetPermissionsUrl, {
      method: 'PATCH',
      headers: {
        'x-api-key': this.key,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(body)
    });

    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { rawBody: text };
      }
    }

    if (!res.ok) {
      const detail =
        data?.error?.message ||
        data?.errors?.[0]?.message ||
        data?.message ||
        data?.rawBody ||
        text ||
        res.statusText;
      const code =
        data?.error?.code ||
        data?.errors?.[0]?.code;
      throw new Error(
        `Roblox Open Cloud asset permission failed (${res.status})` +
        `${code ? ` ${code}` : ''}` +
        `${detail ? `: ${detail}` : ''}`
      );
    }

    // A 200 can contain per-asset failures, so don't rely on response.ok alone.
    const grantErrors = Array.isArray(data?.errors) ? data.errors : [];
    const matchingError = grantErrors.find(
      item => String(item?.assetId ?? '') === String(numericAssetId)
    );
    if (matchingError || grantErrors.length > 0) {
      const err = matchingError || grantErrors[0];
      throw new Error(
        `Roblox Open Cloud asset permission returned an asset error` +
        `${err?.code ? ` (${err.code})` : ''}` +
        `${err?.assetId ? ` for ${err.assetId}` : ''}.`
      );
    }

    const successIds = Array.isArray(data?.successAssetIds)
      ? data.successAssetIds.map(String)
      : null;

    if (successIds && successIds.length > 0 && !successIds.includes(String(numericAssetId))) {
      throw new Error(
        `Roblox Open Cloud returned 200 but did not confirm asset ${numericAssetId} in successAssetIds.`
      );
    }

    return {
      ok: true,
      status: res.status,
      data,
      assetId: String(numericAssetId),
      universeId: String(universeId)
    };
  }

  async fetchModerationDocument(assetId, operationId) {
    const docs = [];

    // Some Open Cloud responses expose moderation state on the operation.
    if (operationId) {
      try {
        docs.push({ source: 'operation', data: await this.getOperation(operationId) });
      } catch (err) {
        docs.push({ source: 'operation-error', error: err });
      }
    }

    // Try the public Open Cloud asset metadata endpoint.
    if (assetId) {
      const url = this.statusUrlTemplate
        ? this.statusUrlTemplate.replaceAll('{assetId}', encodeURIComponent(assetId))
        : `${this.assetBase}/${encodeURIComponent(assetId)}`;
      try {
        const res = await fetch(url, { headers: { 'x-api-key': this.key } });
        const data = await res.json().catch(() => ({}));
        if (res.ok) docs.push({ source: 'asset', data });
        else docs.push({ source: 'asset-error', status: res.status, data });
      } catch (err) {
        docs.push({ source: 'asset-error', error: err });
      }
    }

    return docs;
  }

  async getModerationStatus(assetId, operationId) {
    if (this.simulate) return { status: 'approved', label: 'Simulated approval', source: 'simulation' };
    const docs = await this.fetchModerationDocument(assetId, operationId);

    for (const doc of docs) {
      if (!doc.data) continue;
      const decision = readModerationDecision(doc.data);
      if (decision) return { ...decision, source: doc.source };
    }

    // Crucially, lack of a final moderation field remains PENDING.
    // We never promote the asset merely because creation succeeded.
    return { status: 'pending', label: 'Pending review', source: 'no-final-decision' };
  }
}
