import * as Cesium from "cesium";

export var terrain = new Cesium.CesiumTerrainProvider({
  url: Cesium.IonResource.fromAssetId(3956),
  requestVertexNormals: true,
});
