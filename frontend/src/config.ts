export const NETWORK_LABEL = import.meta.env.VITE_NETWORK_LABEL ?? `ALGORAND MAINNET`;

const explorerBase = import.meta.env.VITE_EXPLORER ?? 'https://allo.info' 

export function blockExplorerUrl(block: number): string {
  return `${explorerBase}/block/${block}`;
}
