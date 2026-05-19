import { useState } from "react";
import PageHeader from "../components/PageHeader";
import Button from "../components/Button";
import Card from "../components/Card";
import Modal from "../components/Modal";
import StatusBadge from "../components/StatusBadge";
import EmptyState from "../components/EmptyState";
import { useSourceList, useAddSource, useRemoveSource } from "../hooks/useSources";

export default function SourcesPage() {
  const { sources, loading, refresh } = useSourceList();
  const { addFolder, addFile } = useAddSource();
  const { remove } = useRemoveSource();
  const [modalOpen, setModalOpen] = useState(false);
  const [folderPath, setFolderPath] = useState("");
  const [addMode, setAddMode] = useState<"folder" | "file">("folder");
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const handleAdd = async () => {
    if (!folderPath.trim()) return;
    if (addMode === "folder") {
      await addFolder(folderPath.trim());
    } else {
      await addFile(folderPath.trim());
    }
    setFolderPath("");
    setModalOpen(false);
    refresh();
  };

  const handleRemove = async (id: string) => {
    await remove(id);
    setConfirmRemove(null);
    refresh();
  };

  if (loading) {
    return (
      <div>
        <PageHeader title="Sources" description="Manage your data sources" />
        <p>Loading...</p>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Sources"
        description="Manage your data sources"
        actions={
          <Button onClick={() => setModalOpen(true)}>Add Source</Button>
        }
      />

      {sources.length === 0 ? (
        <EmptyState
          icon="\uD83D\uDCC1"
          title="No sources connected"
          message="Add a local folder or file to start indexing and searching your content."
          action={
            <Button onClick={() => setModalOpen(true)}>Add Source</Button>
          }
        />
      ) : (
        <div
          style={{
            display: "grid",
            gap: "var(--spacing-md)",
          }}
        >
          {sources.map((source) => (
            <Card key={source.id}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                }}
              >
                <div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "var(--spacing-sm)",
                      marginBottom: "var(--spacing-xs)",
                    }}
                  >
                    <span className="card-title" style={{ margin: 0 }}>
                      {source.path}
                    </span>
                    <StatusBadge status={source.status} />
                  </div>
                  <div className="card-description">
                    {source.sourceType === "local_folder" ? "Folder" : "File"}{" "}
                    &middot; {source.fileCount} files
                    {source.lastIndexed && (
                      <>
                        {" "}
                        &middot; Last indexed:{" "}
                        {new Date(source.lastIndexed).toLocaleString()}
                      </>
                    )}
                  </div>
                </div>
                <Button
                  variant="danger"
                  onClick={() => setConfirmRemove(source.id)}
                >
                  Remove
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Add Source"
      >
        <div style={{ display: "flex", gap: "var(--spacing-sm)", marginBottom: "var(--spacing-md)" }}>
          <Button
            variant={addMode === "folder" ? "primary" : "secondary"}
            onClick={() => setAddMode("folder")}
          >
            Local Folder
          </Button>
          <Button
            variant={addMode === "file" ? "primary" : "secondary"}
            onClick={() => setAddMode("file")}
          >
            Local File
          </Button>
        </div>
        <input
          className="input"
          placeholder={
            addMode === "folder"
              ? "Enter folder path (e.g., /home/user/docs)"
              : "Enter file path (e.g., /home/user/report.md)"
          }
          value={folderPath}
          onChange={(e) => setFolderPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleAdd();
          }}
        />
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: "var(--spacing-sm)",
            marginTop: "var(--spacing-md)",
          }}
        >
          <Button variant="secondary" onClick={() => setModalOpen(false)}>
            Cancel
          </Button>
          <Button onClick={handleAdd} disabled={!folderPath.trim()}>
            Add
          </Button>
        </div>
      </Modal>

      <Modal
        isOpen={confirmRemove !== null}
        onClose={() => setConfirmRemove(null)}
        title="Remove Source"
      >
        <p style={{ marginBottom: "var(--spacing-md)" }}>
          Are you sure you want to remove this source? This will delete all
          indexed content from this source.
        </p>
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: "var(--spacing-sm)",
          }}
        >
          <Button variant="secondary" onClick={() => setConfirmRemove(null)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => confirmRemove && handleRemove(confirmRemove)}
          >
            Remove
          </Button>
        </div>
      </Modal>
    </div>
  );
}
