ALTER TABLE "graph_edges" ADD CONSTRAINT "graph_edges_unique" UNIQUE("from_node_id","to_node_id","relation");
