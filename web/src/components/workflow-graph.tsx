import { useMemo } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  Position,
  type Node,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { WorkflowDefinition, Run } from '../lib/workflows';

export function WorkflowGraph({
  definition,
  run,
  onSelect,
}: {
  definition: WorkflowDefinition;
  run?: Run | null;
  onSelect: (id: string) => void;
}) {
  const { nodes, edges } = useMemo(() => {
    const depths = new Map<string, number>();
    const depth = (id: string): number => {
      if (depths.has(id)) return depths.get(id)!;
      const step = definition.steps.find((s) => s.id === id)!;
      const value = step.dependsOn.length
        ? Math.max(...step.dependsOn.map(depth)) + 1
        : 1;
      depths.set(id, value);
      return value;
    };
    const lanes = new Map<number, number>();
    const nodes: Node[] = [
      {
        id: '__trigger',
        position: { x: 0, y: 0 },
        data: { label: `${run?.trigger ?? definition.trigger.kind} trigger` },
        className: 'wf-graph-node',
      },
    ];
    const edges: Edge[] = [];
    for (const step of definition.steps) {
      const column = depth(step.id);
      const lane = lanes.get(column) ?? 0;
      lanes.set(column, lane + 1);
      const status =
        run?.steps?.find((s) => s.step_id === step.id)?.status ?? 'pending';
      nodes.push({
        id: step.id,
        position: { x: column * 260, y: lane * 135 },
        data: {
          label: (
            <>
              <strong>{step.title}</strong>
              <small>
                {step.specialist} · {status}
              </small>
            </>
          ),
        },
        className: `wf-graph-node ${status}`,
      });
      for (const source of step.dependsOn.length
        ? step.dependsOn
        : ['__trigger'])
        edges.push({
          id: `${source}-${step.id}`,
          source,
          target: step.id,
          animated: status === 'running',
        });
    }
    return {
      nodes: nodes.map((node) => ({
        ...node,
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
      })),
      edges,
    };
  }, [definition, run]);
  return (
    <>
      <div className="wf-graph">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          fitView
          nodesDraggable={false}
          nodesConnectable={false}
          onNodeClick={(_, node) =>
            node.id !== '__trigger' && onSelect(node.id)
          }
          minZoom={0.2}
        >
          <Background />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      <div className="wf-mobile-steps" aria-label="Workflow steps">
        {definition.steps.map((step) => (
          <button key={step.id} onClick={() => onSelect(step.id)}>
            <strong>{step.title}</strong>
            <small>
              {step.specialist} ·{' '}
              {run?.steps?.find((s) => s.step_id === step.id)?.status ??
                'pending'}
            </small>
            {step.dependsOn.length > 0 && (
              <small>
                After:{' '}
                {step.dependsOn
                  .map((id) => definition.steps.find((s) => s.id === id)?.title)
                  .join(', ')}
              </small>
            )}
          </button>
        ))}
      </div>
    </>
  );
}
