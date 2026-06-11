import PageHeader from "../components/PageHeader";
import ConceptGraphPanel from "../components/ConceptGraphPanel";
import { useMemories } from "../hooks/useSubstrate";

/**
 * Full-page surface for the knowledge concept graph (route
 * `/knowledge`, "Knowledge Graph" in the sidebar). Loads the memory
 * plane once so the embedded {@link ConceptGraphPanel} can resolve
 * source evidence + citations when a concept is selected, then renders
 * the graph at a larger canvas height than the embedded variants on
 * MemoryPage / SourceDetailPage.
 */
export default function KnowledgePage() {
  const { memories } = useMemories(null);
  return (
    <div>
      <PageHeader
        title="Knowledge Graph"
        description="Concepts and the typed relationships Tessera has inferred across your sources."
      />
      <ConceptGraphPanel
        memories={memories}
        maxNodes={200}
        height={560}
        data-testid="knowledge-page-graph"
      />
    </div>
  );
}
