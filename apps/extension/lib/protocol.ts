import { browser } from 'wxt/browser';
import type { LeadInput } from '@leadgen/shared';

export type PanelCommand =
  | { type: 'GET_STATE' }
  | { type: 'LOGIN'; email: string; password: string }
  | { type: 'LOGOUT' }
  | { type: 'ACCOUNT' }
  | { type: 'START'; business: string; area: string; limit: number; tabId: number }
  | { type: 'RESUME'; tabId: number }
  | { type: 'PAUSE' }
  | { type: 'STOP' }
  | { type: 'EXPORT'; jobId: string };
export type RecoveryCommand = { type: 'EXPORT_UNSYNCED' };
export type ContentCommand =
  | { type: 'READY' }
  | { type: 'RECORD'; lead: LeadInput }
  | { type: 'SKIP'; key: string }
  | { type: 'FINISH'; reason: string }
  | { type: 'INTERRUPT'; reason: string };
export async function send<T>(message: PanelCommand | ContentCommand | RecoveryCommand): Promise<T> {
  const result = await browser.runtime.sendMessage(message) as { ok: boolean; data?: T; message?: string; code?: string };
  if (!result?.ok) throw new Error(result?.message || 'The extension could not complete this action.');
  return result.data as T;
}
