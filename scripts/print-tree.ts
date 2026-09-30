// Prints the data tree built from src/data/layers.json:  npm run tree
import { DATA_TREE, SNAPSHOT_DATE, datasets, outline } from "../src/app/datatree";

console.log(`Data tree (snapshot ${SNAPSHOT_DATE}, ${datasets().length} datasets)\n`);
console.log(
  outline((d) => {
    const tags = [d.kind === "point" ? "stations" : d.step, d.run !== "observed" ? d.run : "", d.actions.join("+")];
    return `[${d.layer.id}] ${d.label} (${tags.filter(Boolean).join(", ")})`;
  }, DATA_TREE),
);
