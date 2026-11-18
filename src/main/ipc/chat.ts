import { CH } from '@shared/api';
import { schemas } from '@shared/schemas';
import type { ChatStartRequest, ConversationDetail } from '@shared/types';
import { relayError } from '../net/errors';
import { handle, type AppContext } from './register';

export function registerChatIpc(ctx: AppContext): void {
  const { store, streams } = ctx;

  handle(ctx, CH.chatStart, schemas.chatStart, (req) => streams.start(req as ChatStartRequest));
  handle(ctx, CH.chatCancel, schemas.chatCancel, ({ streamId }) => streams.cancel(streamId));

  handle(ctx, CH.convList, schemas.convList, (opts) => store.listConversations(opts));

  handle(ctx, CH.convGet, schemas.convId, ({ id }): ConversationDetail => ({
    conversation: store.requireConversation(id),
    messages: store.listMessages(id),
  }));

  handle(ctx, CH.convCreate, schemas.convCreate, (input) => store.createConversation(input));

  handle(ctx, CH.convUpdate, schemas.convUpdate, ({ id, patch }) => {
    if ((patch.activeLeafId !== undefined || patch.providerId || patch.modelId) && streams.isStreaming(id)) {
      throw relayError('busy', 'Wait for the reply to finish, or stop it, before changing this.');
    }
    return store.updateConversation(id, patch);
  });

  handle(ctx, CH.convDelete, schemas.convId, ({ id }) => {
    if (streams.isStreaming(id)) throw relayError('busy', 'Stop the reply before deleting this conversation.');
    // Deleting a chat also deletes its images, unless another chat uses the same file.
    for (const sha of store.deleteConversation(id)) ctx.attachments.remove(sha);
  });
}
