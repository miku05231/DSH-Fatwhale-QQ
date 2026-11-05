// DSH version gates. The bridge has no npm dependencies, so this stays a tiny
// comparator instead of pulling in semver. Prereleases sort before the release.

export function parseDshVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(value ?? '').trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ? match[4].split('.') : null,
  };
}

function comparePre(left, right) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const aNum = /^\d+$/.test(a);
    const bNum = /^\d+$/.test(b);
    if (aNum && bNum) {
      const diff = Number(a) - Number(b);
      if (diff !== 0) return diff;
    } else if (aNum !== bNum) {
      return aNum ? -1 : 1;
    } else if (a !== b) {
      return a < b ? -1 : 1;
    }
  }
  return 0;
}

/** @returns negative when left < right, 0 when equal, positive when left > right. Unparseable versions compare as older. */
export function compareDshVersion(left, right) {
  const a = parseDshVersion(left);
  const b = parseDshVersion(right);
  if (!a || !b) return a ? 1 : b ? -1 : 0;
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (!a.pre && !b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  return comparePre(a.pre, b.pre);
}

export function dshVersionGte(version, target) {
  return compareDshVersion(version, target) >= 0;
}

/** 0.2.2 splits native and PTC executors and rejects the old tools.mode config. */
export function dshSplitsToolExecutors(version) {
  return dshVersionGte(version, '0.2.2-rc.1') || dshVersionGte(version, '0.2.2');
}

/**
 * Record a model choice on the agent. 0.2.2 fixes the step route through
 * agent.model before prompt assembly; older hosts still expose selectForNextRequest.
 */
export async function selectAgentModel(agent, legacySelector, selected) {
  if (agent?.model && typeof agent.model.select === 'function') {
    agent.model.select(selected);
    return;
  }
  if (typeof legacySelector?.selectForNextRequest === 'function') {
    await legacySelector.selectForNextRequest(agent, selected);
    return;
  }
  throw new Error('不能应用模型选择：宿主没有 agent.model，也没有 selectForNextRequest');
}

/** 0.2.2 installModelSelection only observes the step's fixed route. Older hosts still take a mutable selection. */
export function installChatOnlyModelSelection(installModelSelection, agentCtx, selection) {
  if (typeof installModelSelection !== 'function') {
    throw new Error('This DSH version cannot install chat-only model selection.');
  }
  if (installModelSelection.length >= 2) {
    installModelSelection(agentCtx, { current: selection, assembled: undefined });
    return;
  }
  installModelSelection(agentCtx);
}
