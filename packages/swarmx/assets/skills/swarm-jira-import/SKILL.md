---
name: swarm-jira-import
description: Jira import flow for swarm/swarmx missions. Load when a swarm mission starts with --jira <KEY> or when the coordinator asks to import a Jira ticket as the mission task. Covers the MCP availability gate, ticket fetch, prompt-engineer rewrite, and handoff back to the normal decomposition flow.
metadata:
  target_agents: swarm-planner
---

# Swarm Jira Import Mode

Flux exécuté EN PREMIER quand une mission swarm démarre avec `--jira <KEY>`. La Phase 0
du coordinateur (clarification + triplet) est différée à l'étape 3 — pas ignorée.

## Step 1 — Gate MCP puis fetch

**Gate (renforcé suite à SPOM-4808, ~$38)** : avant TOUTE découverte, vérifier la
présence effective du tool `get_issue` dans les outils disponibles de la session (et
`atlassian` non `enabled:false` dans `.opencode/opencode.json`).
- Absent → **échec immédiat en 1 tour** : reporter que l'import Jira est indisponible
  et demander ré-activation du MCP. Jamais de découverte multi-tours (4+ tours = échec
  de protocole), jamais deviner le contenu du ticket.
- Présent → `get_issue(issue_key="<KEY>")` : description, commentaires, critères
  d'acceptation, issues liées.

## Step 2 — Rewrite par prompt-engineer

Spawner un sous-agent `prompt-engineer` via `task` avec le contenu brut du ticket. Il :
- extrait contexte, exigences, critères d'acceptation ;
- supprime bruit métadonné, IDs internes, transitions workflow ;
- structure avec des délimiteurs XML ;
- applique `stop-slop`, optimise les tokens ;
- retourne un prompt de tâche prêt à l'emploi.

## Step 3 — Ré-évaluer le triplet Phase 0

Avec le prompt réécrit : vérifier tickets / modules-fichiers ciblés / tests ciblés.
Modules ou tests encore manquants que le ticket ne précisait pas → UNE question de
clarification, comme pour toute mission. L'exception Jira s'arrête ici.

## Step 4 — Run Swarm

Le prompt réécrit devient la tâche du flux normal du coordinateur (Knowledge Gathering
→ Decompose → Dispatch → Review), sélection dynamique d'agent incluse. Retour au command
appelant — cette skill ne gère rien après l'étape 3.
