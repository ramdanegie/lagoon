import { contextBridge, ipcRenderer, webUtils } from 'electron'

// The whole renderer ↔ main surface: one RPC call, one event subscription.
const api = {
  call: <T = unknown>(method: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke('rpc', method, args),
  on: (event: string, cb: (...args: unknown[]) => void): (() => void) => {
    const h = (_e: Electron.IpcRendererEvent, ...a: unknown[]): void => cb(...a)
    ipcRenderer.on(event, h)
    return () => ipcRenderer.removeListener(event, h)
  },
  pathForFile: (f: File): string => webUtils.getPathForFile(f),
  platform: process.platform
}

contextBridge.exposeInMainWorld('api', api)
export type Api = typeof api
