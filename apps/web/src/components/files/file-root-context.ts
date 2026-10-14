import { createContext, useContext } from "react"

// Empty for host files: the displayed path begins at /. Other workspaces
// present their mounted data directory as /data.
export const FileRootPathContext = createContext("/data")
export function useFileRootPath(): string {
  return useContext(FileRootPathContext)
}
