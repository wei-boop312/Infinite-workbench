import type {OwnedCancellationReceipt} from '../../api/src/ownedCancellationReceipt.ts';
export class OwnedRuntimeCancellation extends Error {
  constructor(readonly receipt:OwnedCancellationReceipt){super('OWNED_COMFY_CANCELLED');}
}
