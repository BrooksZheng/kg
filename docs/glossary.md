---
kind: kg.project_document
title: "kg glossary"
doc_type: glossary
status: draft
owners: [brooks]
supersedes: null
source_refs:
  - docs/rfc-001-project-knowledge-growth-protocol.md
  - docs/rfc-002-agents-md-compiled-artifact.md
  - docs/rfc-004-authoring-plane-and-brownfield-bootstrap.md
---

# kg glossary

| Term | Meaning | Evidence |
| --- | --- | --- |
| Authoring Plane | Visible project-document space where complete artifacts are directly drafted and reviewed | `docs/rfc-004-authoring-plane-and-brownfield-bootstrap.md` |
| Brownfield | A host project that already contains code or documentation when KG is installed | `docs/rfc-004-authoring-plane-and-brownfield-bootstrap.md` |
| Carrier | A native surface consumed by an Agent, such as AGENTS.md, a Skill, a test, or a reference document | `docs/rfc-001-project-knowledge-growth-protocol.md` |
| Compile | Dedicated governed session that turns accepted documents and observations into atomic knowledge | `skills/kg-compile/SKILL.md` |
| Fast track | Immediate single-observation compile path used for human corrections | `skills/kg-observe/SKILL.md` |
| KG | Project Knowledge Growth, the complete document, learning, ledger, and publication system | `README.md` |
| Knowledge Entry | One governed atomic claim stored under `knowledge/` | `protocol/knowledge.schema.yaml` |
| KYAML | The strict dependency-free YAML subset used by KG machine surfaces | `scripts/lib/kyaml.mjs` |
| Ledger Layer | Stable governance product containing schemas, authority, lifecycle, queue, evidence, and regret | `docs/rfc-002-agents-md-compiled-artifact.md` |
| Managed block | Generated section of AGENTS.md bounded by KG anchors | `scripts/lib/agents-block.mjs` |
| Observation | One continuous-learning signal composed of claim, evidence, and scope | `protocol/observation.schema.yaml` |
| Registered project document | Markdown that opts into source governance with `kind: kg.project_document` | `protocol/project-document.schema.yaml` |
| Render Layer | Replaceable adapter that publishes governed knowledge into Agent carriers | `docs/rfc-002-agents-md-compiled-artifact.md` |
| Scan | Static brownfield discovery workflow that produces evidence-backed draft documents | `skills/kg-scan/SKILL.md` |
| Shape | Semantic step that converts raw evidence into facts, inferences, conflicts, unknowns, and document drafts | `skills/kg-scan/references/scan-playbook.md` |
