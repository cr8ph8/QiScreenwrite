/** Native folder selection grants access to the existing QiMovi project only.
 * The page cannot choose a path or receive credentials from the native host. */
type WriterNativeBridge = { postMessage(value: { action: 'authorize-qimovi' }): Promise<unknown> };
const bridge = () => (window as Window & { webkit?: { messageHandlers?: { writerSession?: WriterNativeBridge } } }).webkit?.messageHandlers?.writerSession;
export const canAuthorizeQiMoviFolder = () => typeof bridge()?.postMessage === 'function';
export async function authorizeQiMoviFolder(): Promise<boolean> {
  const native = bridge();
  if (!native) throw new Error('Open QiCanIScreenwrite from Applications to choose the QiMovi project folder.');
  return await native.postMessage({ action: 'authorize-qimovi' }) === true;
}
