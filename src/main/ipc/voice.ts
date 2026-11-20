import { CH } from '@shared/api';
import { schemas } from '@shared/schemas';
import type { SpokenAudio } from '@shared/types';
import { handle, type AppContext } from './register';

/**
 * Voice chat: the window records and plays audio, and everything that needs
 * the API key happens here. Audio passes through and is not kept: the chat
 * stores the transcript as an ordinary text message. Logs record sizes only.
 */
export function registerVoiceIpc(ctx: AppContext): void {
  const { models, log } = ctx;

  handle(ctx, CH.voiceAvailable, schemas.providerId, ({ providerId }) => models.speech(providerId) !== null);

  handle(ctx, CH.voiceTranscribe, schemas.voiceTranscribe, async ({ providerId, mime, data }) => {
    const text = await models.requireSpeech(providerId).transcribe({ mime, data });
    log.info('voice: transcribed', { bytes: data.byteLength, chars: text.length });
    return text;
  });

  handle(ctx, CH.voiceSpeak, schemas.voiceSpeak, async ({ providerId, text }): Promise<SpokenAudio> => {
    const audio = await models.requireSpeech(providerId).speak(text);
    log.info('voice: spoke', { chars: text.length, bytes: audio.data.byteLength });
    return audio;
  });
}
