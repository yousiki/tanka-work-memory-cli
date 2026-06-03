/** Run an async function, exposing loading / ok / error state with a reload. */
import { useEffect, useState } from 'react';

export interface AsyncState<T> {
  status: 'loading' | 'ok' | 'error';
  data?: T;
  error?: string;
}

export function useAsync<T>(
  fn: () => Promise<T>,
  deps: ReadonlyArray<unknown>,
): AsyncState<T> & { reload: () => void } {
  const [state, setState] = useState<AsyncState<T>>({ status: 'loading' });
  const [nonce, setNonce] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are caller-supplied by design; including `fn` would refire every render on a new function identity.
  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    fn().then(
      (data) => {
        if (!cancelled) setState({ status: 'ok', data });
      },
      (err: unknown) => {
        if (!cancelled) {
          setState({
            status: 'error',
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [...deps, nonce]);

  return { ...state, reload: () => setNonce((n) => n + 1) };
}
