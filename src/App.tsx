import "./App.css";
import { Viewer } from "resium";
import GsiTerrainProvider from "cesium-gsi-terrain";
// import {terrain} from "./terrain";

import {MartiniTerrainProvider} from "@macrostrat/cesium-martini";

function App() {

  return (
    <div className="App">
      <Viewer full terrainProvider={new GsiTerrainProvider({})}/>
    </div>
  );
}

export default App;
