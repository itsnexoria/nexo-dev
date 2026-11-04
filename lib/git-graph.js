'use strict';
// Lane assignment for a commit graph. Input: commits in topological order (children before
// parents, as `git log --topo-order` prints them) as [{ hash, parents: [hash...] }].
// Output: one row per commit describing what to draw in that row's cell:
//   lane      column of the commit dot
//   color     colour index of the dot's lane
//   incoming  [{lane,color}] lines arriving from above into the dot (one per child lane merged here)
//   through   [{lane,color}] lanes that simply pass through this row
//   outgoing  [{from,to,color}] lines from the dot down to the lanes of its parents
//   laneCount number of columns needed
function computeGraph(commits) {
  let active = [];   // lane index -> { hash, color } | null
  let nextColor = 0;
  const rows = [];
  for (const c of commits) {
    const parents = Array.isArray(c.parents) ? c.parents : [];
    const incoming = [];
    for (let i = 0; i < active.length; i++) if (active[i] && active[i].hash === c.hash) incoming.push(i);
    let lane;
    let color;
    if (incoming.length) { lane = incoming[0]; color = active[lane].color; }
    else {
      lane = active.indexOf(null);
      if (lane === -1) { lane = active.length; active.push(null); }
      color = nextColor++;
    }
    const inc = incoming.map((i) => ({ lane: i, color: active[i].color }));
    const through = [];
    for (let i = 0; i < active.length; i++) if (active[i] && active[i].hash !== c.hash) through.push({ lane: i, color: active[i].color });
    const widthBefore = active.length;

    // free the lanes that converge on this commit
    for (const i of incoming) active[i] = null;
    const outgoing = [];
    parents.forEach((p, k) => {
      let target = active.findIndex((a) => a && a.hash === p);
      if (target !== -1) { outgoing.push({ from: lane, to: target, color: active[target].color }); return; }
      if (k === 0) {
        target = lane; // first parent continues in the commit's own lane
        active[target] = { hash: p, color };
        outgoing.push({ from: lane, to: target, color });
      } else {
        target = active.indexOf(null);
        if (target === -1) { target = active.length; active.push(null); }
        const col = nextColor++;
        active[target] = { hash: p, color: col };
        outgoing.push({ from: lane, to: target, color: col });
      }
    });
    // through lanes that stay alive below this row must be drawn through as well (they are in `through`)
    const outThrough = through.map((t) => t); // unchanged: they stay in their lane
    while (active.length && active[active.length - 1] === null) active.pop();
    rows.push({
      hash: c.hash, lane, color, incoming: inc, through: outThrough, outgoing,
      laneCount: Math.max(widthBefore, active.length, lane + 1, ...outgoing.map((o) => o.to + 1)),
    });
  }
  return rows;
}

module.exports = { computeGraph };
