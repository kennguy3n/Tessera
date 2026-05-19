export type SourceType = "local_folder" | "local_file";

export type SourceStatus = "connected" | "indexing" | "error" | "disconnected";

export interface Source {
  id: string;
  sourceType: SourceType;
  path: string;
  status: SourceStatus;
  createdAt: string;
  lastIndexed: string | null;
  fileCount: number;
}
