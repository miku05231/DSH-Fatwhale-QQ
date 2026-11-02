if (process.env.ASTRBOT_NATIVE_TEST !== '1') {
  console.log('AstrBot native acceptance skipped; set ASTRBOT_NATIVE_TEST=1 to opt in.');
} else {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  const APP_ROOT = '/app';
  const STATE_DIR = '/app/state';
  const MARKER_PATH = path.join(STATE_DIR, '.astrbot-acceptance-only');
  const FIXTURE_PATH = path.resolve(process.env.ASTRBOT_TEST_PLUGIN_ZIP || path.join(STATE_DIR, 'fixture.zip'));
  const EXPECTED_FIXTURE_PATH = path.join(STATE_DIR, 'fixture.zip');

  function acceptanceError(code) {
    return Object.assign(new Error(code), { code });
  }

  function requireThat(value, code) {
    if (!value) throw acceptanceError(code);
  }

  function safeErrorCode(error) {
    const value = String(error?.code || '');
    return /^ASTRBOT_[A-Z0-9_]{1,64}$/.test(value) ? value : 'ASTRBOT_ACCEPTANCE_UNEXPECTED_ERROR';
  }

  function safeJobField(value, fallback) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,48}$/.test(value) ? value : fallback;
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const runId = Date.now().toString(36);

  async function waitForJob(manager, id) {
    const deadline = Date.now() + 20 * 60 * 1000;
    let previous = '';
    while (Date.now() < deadline) {
      const job = await manager.job(id);
      requireThat(job && typeof job === 'object', 'ASTRBOT_ACCEPTANCE_JOB_NOT_FOUND');
      const phase = safeJobField(job.phase, 'queued');
      const status = safeJobField(job.status, 'unknown');
      const error = /^ASTRBOT_[A-Z0-9_]{1,64}$/.test(String(job.error?.code || ''))
        ? job.error.code : '';
      const state = JSON.stringify({ phase, status, error });
      if (state !== previous) {
        console.log(state);
        previous = state;
      }
      if (status === 'succeeded') return job;
      if (status === 'failed') throw acceptanceError(error || 'ASTRBOT_ACCEPTANCE_JOB_FAILED');
      await sleep(Math.min(2000, Math.max(1, deadline - Date.now())));
    }
    throw acceptanceError('ASTRBOT_ACCEPTANCE_JOB_TIMEOUT');
  }

  function message(id, text, userId = '789') {
    return {
      messageType: 'group',
      groupId: '123',
      userId,
      text,
      raw: {
        message_id: `${runId}-${id}`,
        message: [{ type: 'text', data: { text } }],
        // A QQ title must never grant project-administrator permissions.
        sender: { role: userId === '789' ? 'owner' : 'member', nickname: 'acceptance-fixture' },
      },
    };
  }

  function sentText(item) {
    const parts = Array.isArray(item?.params?.message) ? item.params.message : [];
    return parts.filter((part) => part?.type === 'text' && typeof part?.data?.text === 'string')
      .map((part) => part.data.text).join('');
  }

  async function waitForSend(sends, text, from, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = sends.slice(from).find((item) => sentText(item) === text);
      if (found) return found;
      await sleep(100);
    }
    throw acceptanceError('ASTRBOT_ACCEPTANCE_SCHEDULED_SEND_TIMEOUT');
  }

  async function mediaBytes(item, type) {
    const component = item?.params?.message?.find((part) => part.type === type);
    if (!component?.data?.file?.startsWith('file:///app/state/astrbot/media/')) {
      console.log(JSON.stringify({ phase: 'media-cache-diagnostic', expected: type,
        parts: (item?.params?.message || []).map((part) => ({ type: part.type,
          scheme: String(part.data?.file || '').split(':', 1)[0], keys: Object.keys(part.data || {}) })) }));
    }
    requireThat(component?.data?.file?.startsWith('file:///app/state/astrbot/media/'),
      'ASTRBOT_ACCEPTANCE_MEDIA_CACHE_REQUIRED');
    requireThat(component.data.file.endsWith(type === 'image' ? '.png' : '.wav'),
      'ASTRBOT_ACCEPTANCE_MEDIA_EXTENSION_INVALID');
    return fs.readFile(fileURLToPath(component.data.file));
  }

  function toolArguments(schema) {
    const parameters = schema?.function?.parameters;
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return null;
    const properties = parameters.properties && typeof parameters.properties === 'object'
      ? parameters.properties : {};
    const args = {};
    for (const key of Array.isArray(parameters.required) ? parameters.required : []) {
      const property = properties[key];
      if (!property || typeof property !== 'object') return null;
      if (Array.isArray(property.enum) && property.enum.length) args[key] = property.enum[0];
      else if (property.type === 'string') args[key] = 'acceptance-tool-value';
      else if (property.type === 'integer' || property.type === 'number') args[key] = 1;
      else if (property.type === 'boolean') args[key] = false;
      else if (property.type === 'array') args[key] = [];
      else if (property.type === 'object') args[key] = {};
      else return null;
    }
    return args;
  }

  function openAiResponse(content, toolCalls = []) {
    return {
      id: 'astrbot-native-acceptance-response',
      object: 'chat.completion',
      created: 0,
      model: 'astrbot-native-acceptance-fixture',
      choices: [{
        index: 0,
        message: { role: 'assistant', content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
        finish_reason: toolCalls.length ? 'tool_calls' : 'stop',
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
  }

  async function main() {
    const marker = await fs.lstat(MARKER_PATH).catch(() => null);
    requireThat(marker?.isFile() && !marker.isSymbolicLink(), 'ASTRBOT_ACCEPTANCE_MARKER_REQUIRED');
    requireThat(path.resolve(FIXTURE_PATH) === EXPECTED_FIXTURE_PATH,
      'ASTRBOT_ACCEPTANCE_FIXTURE_PATH_INVALID');
    const fixtureStat = await fs.lstat(FIXTURE_PATH).catch(() => null);
    requireThat(fixtureStat?.isFile() && !fixtureStat.isSymbolicLink(), 'ASTRBOT_ACCEPTANCE_FIXTURE_REQUIRED');
    requireThat(!process.env.ASTRBOT_RUNTIME_MODE || process.env.ASTRBOT_RUNTIME_MODE === 'external',
      'ASTRBOT_ACCEPTANCE_EXTERNAL_MODE_REQUIRED');
    requireThat(!process.env.ASTRBOT_RUNTIME_URL || /^https?:\/\//i.test(process.env.ASTRBOT_RUNTIME_URL),
      'ASTRBOT_ACCEPTANCE_RUNTIME_URL_INVALID');

    const [{ createAstrbotManager }, { createAstrbotPolicy }, { createAstrbotBridge }] = await Promise.all([
      import('../src/astrbot-manager.mjs'),
      import('../src/astrbot-policy.mjs'),
      import('../src/astrbot-bridge.mjs'),
    ]);

    const cfg = {
      stateDir: '/app/state',
      security: {
        allowGroups: true,
        allowGroupIds: ['123'],
        allowFrom: ['456'],
        denyFrom: [],
        adminUserIds: ['456'],
        allowGroupMembers: false,
      },
      astrbot: {
        enabled: true,
        runtimeMode: 'external',
        runtimeUrl: process.env.ASTRBOT_RUNTIME_URL || 'http://astrbot:5831',
        callbackUrl: 'http://acceptance:5832/rpc/callback',
      },
    };
    const readConfig = () => cfg;
    const manager = createAstrbotManager({
      projectRoot: APP_ROOT,
      configPath: path.join(STATE_DIR, 'acceptance-config.json'),
      readConfig,
      logger: () => {},
    });
    const policy = createAstrbotPolicy({ root: APP_ROOT, readConfig });
    const sends = [];
    const modelRequests = [];
    let toolLoopArmed = false;
    let toolCallSent = false;
    let toolLoopFollowupSeen = false;
    const bridge = createAstrbotBridge({
      root: APP_ROOT,
      readConfig,
      manager,
      policy,
      host: '0.0.0.0',
      port: 5832,
      // This collector is the only message sink. It never opens a QQ connection.
      send: async (action, params) => {
        sends.push({ action, params: structuredClone(params) });
        return { message_id: `acceptance-${sends.length}` };
      },
      generate: async (request) => {
        modelRequests.push(request);
        const messages = Array.isArray(request?.messages) ? request.messages : [];
        if (toolLoopArmed && toolCallSent && messages.some((item) =>
          item?.role === 'tool' || typeof item?.tool_call_id === 'string')) {
          toolLoopFollowupSeen = true;
        }
        if (toolLoopArmed && !toolCallSent) {
          const available = Array.isArray(request?.tools) ? request.tools : [];
          const candidate = available.find((tool) => typeof tool?.function?.name === 'string'
            && toolArguments(tool) !== null);
          if (candidate) {
            toolCallSent = true;
            return openAiResponse('', [{
              id: 'astrbot-acceptance-tool-call',
              type: 'function',
              function: {
                name: candidate.function.name,
                arguments: JSON.stringify(toolArguments(candidate)),
              },
            }]);
          }
        }
        const flattened = JSON.stringify(messages);
        if (flattened.includes('fixture-model-request')) {
          return openAiResponse('controlled-model-response');
        }
        if (flattened.includes('fixture-legacy-request')) {
          return openAiResponse('controlled-legacy-response');
        }
        return openAiResponse('controlled-acceptance-response');
      },
    });

    let runtimeTouched = false;
    let failure = null;
    try {
      // Do not create or replace the shared RPC token: it must be provisioned for this sidecar.
      await manager.getToken({ create: false });
      await bridge.start();
      const archive = await fs.readFile(FIXTURE_PATH);
      requireThat(archive.length > 0 && archive.length <= 16 * 1024 * 1024,
        'ASTRBOT_ACCEPTANCE_FIXTURE_SIZE_INVALID');

      await policy.setEnabled(false);
      runtimeTouched = true;
      if ((await manager.listPlugins()).some((item) => item.id === 'qq_boundary_fixture' && item.enabled)) {
        await manager.configure('qq_boundary_fixture', { enabled: false });
      }
      const install = await manager.install({ zipBase64: archive.toString('base64') });
      const installed = await waitForJob(manager, install.id);
      requireThat(installed.status === 'succeeded', 'ASTRBOT_ACCEPTANCE_INSTALL_FAILED');

      const pluginId = 'qq_boundary_fixture';
      let plugins = await manager.listPlugins();
      let plugin = plugins.find((item) => item.id === pluginId);
      requireThat(plugin && plugin.enabled === false, 'ASTRBOT_ACCEPTANCE_PLUGIN_MUST_DEFAULT_OFF');

      await manager.configure(pluginId, { enabled: true });
      plugins = await manager.listPlugins();
      plugin = plugins.find((item) => item.id === pluginId);
      requireThat(plugin?.enabled === true, 'ASTRBOT_ACCEPTANCE_PLUGIN_ENABLE_FAILED');

      await policy.setGroup('123', { pluginIds: [pluginId], chatMode: 'dsh' });
      await policy.setEnabled(true);

      const dispatches = [];
      const originalRuntimeRpc = manager.runtimeRpc.bind(manager);
      manager.runtimeRpc = async (method, params, options) => {
        if (method === 'dispatch') dispatches.push(params?.event?.messageId);
        return originalRuntimeRpc(method, params, options);
      };

      let result = await bridge.dispatch(message('acceptance-echo-1', '/ast_echo hello'));
      requireThat(result.status === 'handled' && sends.length === 1
        && sends[0].action === 'send_group_msg' && String(sends[0].params.group_id) === '123'
        && sentText(sends[0]) === 'echo:hello', 'ASTRBOT_ACCEPTANCE_ECHO_DISPATCH_FAILED');

      const sendCountAfterEcho = sends.length;
      result = await bridge.dispatch(message('acceptance-unmatched-1', '/acceptance_unmatched_command'));
      requireThat(result.status === 'unhandled' && sends.length === sendCountAfterEcho,
        'ASTRBOT_ACCEPTANCE_UNMATCHED_MUST_REMAIN_UNHANDLED');

      const dispatchCountBeforeDuplicate = dispatches.length;
      result = await bridge.dispatch(message('acceptance-echo-1', '/ast_echo hello'));
      requireThat(result.status === 'duplicate' && sends.length === sendCountAfterEcho
        && dispatches.length === dispatchCountBeforeDuplicate,
      'ASTRBOT_ACCEPTANCE_DUPLICATE_MUST_NOT_RESEND');

      const beforeMemberAdmin = sends.length;
      result = await bridge.dispatch(message('acceptance-admin-member', '/ast_admin', '789'));
      requireThat(sends.length === beforeMemberAdmin
        && !sends.slice(beforeMemberAdmin).some((item) => sentText(item).includes('admin-only')),
      'ASTRBOT_ACCEPTANCE_GROUP_MEMBER_ADMIN_COMMAND_DENIED');

      result = await bridge.dispatch(message('acceptance-admin-project', '/ast_admin', '456'));
      requireThat(result.status === 'handled' && sends.length === beforeMemberAdmin + 1
        && sentText(sends.at(-1)).includes('admin-only'),
      'ASTRBOT_ACCEPTANCE_PROJECT_ADMIN_COMMAND_FAILED');

      const beforeVoice = sends.length;
      result = await bridge.dispatch(message('acceptance-voice-1', '/ast_voice'));
      const voiceItem = sends.slice(beforeVoice).flatMap((item) =>
        Array.isArray(item?.params?.message) ? item.params.message : [])
        .find((part) => part?.type === 'record' && typeof part?.data?.file === 'string');
      requireThat(result.status === 'handled' && voiceItem
        && voiceItem.data.file.startsWith('file:///app/state/astrbot/media/')
        && voiceItem.data.file.endsWith('.wav'),
      'ASTRBOT_ACCEPTANCE_VOICE_MEDIA_HANDLE_FAILED');
      const voiceBytes = await fs.readFile(fileURLToPath(voiceItem.data.file));
      requireThat(voiceBytes.subarray(0, 4).toString('ascii') === 'RIFF'
        && voiceBytes.subarray(8, 12).toString('ascii') === 'WAVE',
      'ASTRBOT_ACCEPTANCE_VOICE_MEDIA_CONTENT_INVALID');

      result = await bridge.dispatch(message('acceptance-image-1', '/ast_image'));
      requireThat(result.status === 'handled', 'ASTRBOT_ACCEPTANCE_IMAGE_NOT_HANDLED');
      const imageSend = sends.at(-1);
      const imageBytes = await mediaBytes(imageSend, 'image');
      requireThat(imageBytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        && imageBytes.readUInt32BE(16) === 2 && imageBytes.readUInt32BE(20) === 2,
      'ASTRBOT_ACCEPTANCE_IMAGE_CONTENT_INVALID');
      const inbound = message('acceptance-incoming-media-1', '/ast_media');
      inbound.raw.message.push(
        { type: 'image', data: { file: imageSend.params.message.find((part) => part.type === 'image').data.file } },
        { type: 'record', data: { file: voiceItem.data.file } },
      );
      const incomingStart = sends.length;
      result = await bridge.dispatch(inbound);
      const incomingSends = sends.slice(incomingStart);
      requireThat(result.status === 'handled' && incomingSends.some((item) =>
        sentText(item).includes('media:count=2; echoed=2;')),
        'ASTRBOT_ACCEPTANCE_INCOMING_MEDIA_NOT_HANDLED');
      // AstrBot's native RespondStage sends Record separately from text/images.
      const echoedImage = incomingSends.find((item) => item.params.message.some((part) => part.type === 'image'));
      const echoedRecord = incomingSends.find((item) => item.params.message.some((part) => part.type === 'record'));
      requireThat((await mediaBytes(echoedImage, 'image')).equals(imageBytes)
        && (await mediaBytes(echoedRecord, 'record')).equals(voiceBytes),
      'ASTRBOT_ACCEPTANCE_INCOMING_MEDIA_CHANGED');
      console.log(JSON.stringify({ phase: 'image-and-incoming-media', status: 'passed' }));

      const timerStart = sends.length;
      result = await bridge.dispatch(message('acceptance-timer-1', `/ast_timer 3 basic-${runId}`));
      requireThat(result.status === 'handled' && sentText(sends.at(-1)).startsWith(`timer-scheduled:basic-${runId};`),
        'ASTRBOT_ACCEPTANCE_TIMER_NOT_SCHEDULED');
      const timedSend = await waitForSend(sends, `timer-fired:basic-${runId}`, timerStart);
      requireThat(String(timedSend.params.group_id) === '123', 'ASTRBOT_ACCEPTANCE_TIMER_TARGET_CHANGED');

      const crossStart = sends.length;
      await bridge.dispatch(message('acceptance-timer-cross-1', `/ast_timer 3 cross-${runId} 999`));
      await waitForSend(sends, `timer-denied-cross-group:cross-${runId}`, crossStart);
      requireThat(sends.slice(crossStart).every((item) => String(item.params.group_id) === '123'),
        'ASTRBOT_ACCEPTANCE_TIMER_CROSSED_GROUP');

      await bridge.dispatch(message('acceptance-timer-revoked-1', `/ast_timer 3 revoked-${runId}`));
      requireThat(sentText(sends.at(-1)).startsWith(`timer-scheduled:revoked-${runId};`),
        'ASTRBOT_ACCEPTANCE_REVOKED_TIMER_NOT_SCHEDULED');
      await policy.removeGroup('123');
      const revokedStart = sends.length;
      await sleep(5500);
      requireThat(sends.length === revokedStart, 'ASTRBOT_ACCEPTANCE_REVOKED_TIMER_DELIVERED');
      await policy.setGroup('123', { pluginIds: [pluginId], chatMode: 'dsh' });

      const restartStart = sends.length;
      await bridge.dispatch(message('acceptance-timer-restart-1', `/ast_timer 30 restart-${runId}`));
      requireThat(sentText(sends.at(-1)).startsWith(`timer-scheduled:restart-${runId};`),
        'ASTRBOT_ACCEPTANCE_PERSISTENT_TIMER_NOT_SCHEDULED');
      await manager.stop();
      const restarted = await manager.start();
      requireThat(restarted?.running === true, 'ASTRBOT_ACCEPTANCE_TIMER_RESTART_FAILED');
      await waitForSend(sends, `timer-fired:restart-${runId}`, restartStart, 45_000);
      requireThat(sends.slice(restartStart).filter((item) => sentText(item) === `timer-fired:restart-${runId}`).length === 1,
        'ASTRBOT_ACCEPTANCE_PERSISTENT_TIMER_DUPLICATED');
      console.log(JSON.stringify({ phase: 'scheduled-send-revoke-cross-group-restart', status: 'passed' }));

      const beforeModel = sends.length;
      result = await bridge.dispatch(message('acceptance-model-1', '/ast_llm'));
      requireThat(result.status === 'handled' && modelRequests.some((request) =>
        JSON.stringify(request?.messages || []).includes('fixture-model-request'))
        && sentText(sends.at(-1)) === 'controlled-model-response',
      'ASTRBOT_ACCEPTANCE_LLM_GENERATE_FAILED');
      requireThat(sends.length > beforeModel, 'ASTRBOT_ACCEPTANCE_LLM_GENERATE_NOT_DELIVERED');

      const beforeLegacy = sends.length;
      result = await bridge.dispatch(message('acceptance-legacy-1', '/ast_legacy'));
      requireThat(result.status === 'handled' && modelRequests.some((request) =>
        JSON.stringify(request?.messages || []).includes('fixture-legacy-request'))
        && sentText(sends.at(-1)) === 'controlled-legacy-response'
        && sends.length > beforeLegacy, 'ASTRBOT_ACCEPTANCE_LEGACY_PROVIDER_FAILED');

      await policy.setGroup('123', { pluginIds: [pluginId], chatMode: 'astrbot' });
      toolLoopArmed = true;
      result = await bridge.dispatch(message('acceptance-tool-loop-1', 'use the fixture tool'), { isWake: true });
      toolLoopArmed = false;
      requireThat(toolCallSent, 'ASTRBOT_ACCEPTANCE_PLUGIN_TOOL_SCHEMA_MISSING');
      requireThat(toolLoopFollowupSeen, 'ASTRBOT_ACCEPTANCE_TOOL_LOOP_DID_NOT_COMPLETE');
      console.log(JSON.stringify({ phase: 'tool-loop', status: 'exercised', error: '' }));
      requireThat(result.status !== 'failed', 'ASTRBOT_ACCEPTANCE_TOOL_DISPATCH_FAILED');

      await policy.removeGroup('123');
      const sendsBeforeRevoked = sends.length;
      const dispatchesBeforeRevoked = dispatches.length;
      result = await bridge.dispatch(message('acceptance-revoked-1', '/ast_echo must-not-run'));
      requireThat(result.status === 'unhandled' && sends.length === sendsBeforeRevoked
        && dispatches.length === dispatchesBeforeRevoked,
      'ASTRBOT_ACCEPTANCE_REVOKED_GROUP_EXECUTED');

      await policy.setGroup('123', { pluginIds: [pluginId], chatMode: 'dsh' });
      const stopped = await manager.stop();
      requireThat(stopped?.stopped === true, 'ASTRBOT_ACCEPTANCE_RUNTIME_STOP_FAILED');
      const started = await manager.start();
      requireThat(started?.running === true && started?.external === true,
        'ASTRBOT_ACCEPTANCE_RUNTIME_RECOVERY_FAILED');
      result = await bridge.dispatch(message('acceptance-recovery-1', '/ast_echo recovered'));
      requireThat(result.status === 'handled' && sentText(sends.at(-1)) === 'echo:recovered',
        'ASTRBOT_ACCEPTANCE_POST_RECOVERY_DISPATCH_FAILED');
    } catch (error) {
      failure = error;
    } finally {
      try { await policy.setEnabled(false); }
      catch (error) { if (!failure) failure = error; }
      if (runtimeTouched) {
        try { await manager.stop(); }
        catch (error) { if (!failure) failure = error; }
      }
      try { await bridge.stop(); }
      catch (error) { if (!failure) failure = error; }
    }

    if (failure) throw acceptanceError(safeErrorCode(failure));
    console.log(JSON.stringify({ status: 'passed' }));
  }

  try {
    await main();
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', error: safeErrorCode(error) }));
    process.exitCode = 1;
  }
}
