import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { applyStickerSendPolicy } from './sticker-send-policy.js';

/** Persist a send claim before OneBot: an interrupted send must never be retried automatically. */
export async function deliverGeneratedImages({ service, contextId, configPath, configRoot, send, canDeliver = () => true, random }) {
  if (!contextId) return { matched: 0, sent: 0, skipped: 0 };
  const jobs = (await service.list()).filter((job) => job.contextId === contextId && job.status === 'completed');
  const result = { matched: jobs.length, sent: 0, skipped: 0 };
  for (const job of jobs) {
    const token = randomUUID();
    const claim = await service.update(job.id, async (current) => {
      if (current.delivery) return null;
      const context = await service.checkContext(contextId, { delivery: true });
      if (!canDeliver()) return null;
      const { file } = await service.artifact(job.id);
      if (current.mode === 'sticker' && !current.sticker) return null;
      const action = context.message.messageType === 'group' ? 'send_group_msg' : 'send_private_msg';
      const target = action === 'send_group_msg' ? { group_id: context.message.groupId } : { user_id: context.message.userId };
      const params = { ...target, message: [{ type: 'image', data: {
        file: pathToFileURL(file).href, ...(current.mode === 'sticker' ? { sub_type: 1 } : {}),
      } }] };
      const policy = await applyStickerSendPolicy(action, params, { configPath, configRoot, random });
      current.delivery = {
        state: policy.skipped ? 'skipped' : 'sending', token, at: new Date().toISOString(),
        probability: policy.probability, target,
      };
      return { action, params: policy.params, skipped: policy.skipped };
    });
    if (!claim) continue;
    if (claim.skipped) { result.skipped += 1; continue; }
    let state = 'unknown';
    try {
      await service.checkContext(contextId, { delivery: true });
      if (!canDeliver()) state = 'cancelled';
      else {
        await send(claim.action, claim.params);
        state = 'sent';
        result.sent += 1;
      }
    } catch { /* A lost acknowledgement may already have delivered the image. */ }
    await service.update(job.id, (current) => {
      if (current.delivery?.token === token) {
        current.delivery.state = state;
        current.delivery.finishedAt = new Date().toISOString();
      }
    });
  }
  return result;
}
