import "./App.css";
import { Viewer } from "resium";
import GsiTerrainProvider from "./terrain-provider";
import {terrain} from "./terrain";

import {MartiniTerrainProvider} from "@macrostrat/cesium-martini";

function App() {

  return (
    <div className="App">
      <Viewer full terrainProvider={MartiniTerrainProvider}/>
    </div>
  );
}

export default App;
