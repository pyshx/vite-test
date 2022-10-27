import {
  Cartographic,
  Rectangle,
  Ellipsoid,
  WebMercatorTilingScheme,
  TerrainProvider,
  Math as CMath,
  Event as CEvent,
  Cartesian3,
  BoundingSphere,
  QuantizedMeshTerrainData,
  HeightmapTerrainData,
  OrientedBoundingBox,
  Credit,
  TileAvailability,
} from "cesium";
import type { NdArray } from "ndarray";
import getPixels from "get-pixels";
import Martini from "@mapbox/martini";

function gsiTerrainToGrid(png: NdArray<Uint8Array>) {
  const gridSize = png.shape[0] + 1;
  const terrain = new Float32Array(gridSize * gridSize);
  const tileSize = png.shape[0];

  // decode terrain values
  for (let y = 0; y < tileSize; y++) {
    for (let x = 0; x < tileSize; x++) {
      const yc = y;
      const r = png.get(x, yc, 0);
      const g = png.get(x, yc, 1);
      const b = png.get(x, yc, 2);
      if (r === 128 && g === 0 && b === 0) {
        terrain[y * gridSize + x] = 0;
      } else {
        terrain[y * gridSize + x] =
          r >= 128
            ? r * 655.36 + g * 2.56 + b * 0.01 + -167772.16
            : r * 655.36 + g * 2.56 + b * 0.01;
      }
    }
  }
  // backfill right and bottom borders
  for (let x = 0; x < gridSize - 1; x++) {
    terrain[gridSize * (gridSize - 1) + x] =
      terrain[gridSize * (gridSize - 2) + x];
  }
  for (let y = 0; y < gridSize; y++) {
    terrain[gridSize * y + gridSize - 1] = terrain[gridSize * y + gridSize - 2];
  }
  return terrain;
}

// https://github.com/CesiumGS/cesium/blob/1.68/Source/Scene/MapboxImageryProvider.js#L42


class GsiTerrainProvider implements TerrainProvider {
  martini: any;
  hasWaterMask = false;
  hasVertexNormals = false;
  credit = new Credit("地理院タイル");
  ready: boolean;
  readyPromise: Promise<boolean>;
  availability: TileAvailability;
  errorEvent = new CEvent();
  tilingScheme: TerrainProvider["tilingScheme"];
  ellipsoid: Ellipsoid;
  format: string;
  tileSize: number = 256;

  constructor(opts?: { ellipsoid?: Ellipsoid }) {
    this.martini = new Martini(this.tileSize + 1);
    this.ready = true;
    this.readyPromise = Promise.resolve(true);

    this.errorEvent.addEventListener(console.log, this);
    this.ellipsoid = opts?.ellipsoid ?? Ellipsoid.WGS84;
    this.format = "png";

    this.tilingScheme = new WebMercatorTilingScheme({
      numberOfLevelZeroTilesX: 1,
      numberOfLevelZeroTilesY: 1,
      ellipsoid: this.ellipsoid,
    });
    this.availability = new TileAvailability(this.tilingScheme, 14);
  }

  async loadTileDataAvailability() {
    return;
  }

  async getPixels(url: string, type = ""): Promise<NdArray<Uint8Array>> {
    return new Promise((resolve, reject) => {
      getPixels(url, type, (err, array) => {
        if (err != null) reject(err);
        resolve(array);
      });
    });
  }

  emptyHeightmap(samples: any) {
    return new HeightmapTerrainData({
      buffer: new Uint8Array(Array(samples * samples).fill(0)),
      width: samples,
      height: samples,
    });
  }

  async createQuantizedMeshData(
    x: number,
    y: number,
    z: number,
    tile: any,
    mesh: any
  ) {
    const err = this.getLevelMaximumGeometricError(z);
    const skirtHeight = err * 5;

    const xvals: number[] = [];
    const yvals: number[] = [];
    const heightMeters: number[] = [];
    const northIndices: number[] = [];
    const southIndices: number[] = [];
    const eastIndices: number[] = [];
    const westIndices: number[] = [];

    for (let ix = 0; ix < mesh.vertices.length / 2; ix++) {
      const vertexIx = ix;
      const px = mesh.vertices[ix * 2];
      const py = mesh.vertices[ix * 2 + 1];
      heightMeters.push(tile.terrain[py * (this.tileSize + 1) + px]);

      if (py == 0) northIndices.push(vertexIx);
      if (py == this.tileSize) southIndices.push(vertexIx);
      if (px == 0) westIndices.push(vertexIx);
      if (px == this.tileSize) eastIndices.push(vertexIx);

      // This saves us from out-of-range values like 32768
      const scalar = 32768 / this.tileSize;
      let xv = px * scalar;
      let yv = (this.tileSize - py) * scalar;

      xvals.push(xv);
      yvals.push(yv);
    }

    const maxHeight = Math.max.apply(this, heightMeters);
    const minHeight = Math.min.apply(this, heightMeters);

    const heights = heightMeters.map((d) => {
      if (maxHeight - minHeight < 1) return 0;
      return (d - minHeight) * (32767 / (maxHeight - minHeight));
    });

    const tileRect = this.tilingScheme.tileXYToRectangle(x, y, z);
    const tileCenter = Cartographic.toCartesian(Rectangle.center(tileRect));
    // Need to get maximum distance at zoom level
    // tileRect.width is given in radians
    // cos of half-tile-width allows us to use right-triangle relationship
    const cosWidth = Math.cos(tileRect.width / 2); // half tile width since our ref point is at the center
    // scale max height to max ellipsoid radius
    // ... it might be better to use the radius of the entire
    const ellipsoidHeight = maxHeight / this.ellipsoid.maximumRadius;
    // cosine relationship to scale height in ellipsoid-relative coordinates
    const occlusionHeight = (1 + ellipsoidHeight) / cosWidth;

    const scaledCenter =
      Ellipsoid.WGS84.transformPositionToScaledSpace(tileCenter);
    const horizonOcclusionPoint = new Cartesian3(
      scaledCenter.x,
      scaledCenter.y,
      occlusionHeight
    );

    let orientedBoundingBox;
    let boundingSphere: BoundingSphere;
    if (tileRect.width < CMath.PI_OVER_TWO + CMath.EPSILON5) {
      orientedBoundingBox = OrientedBoundingBox.fromRectangle(
        tileRect,
        minHeight,
        maxHeight
      );
      boundingSphere =
        BoundingSphere.fromOrientedBoundingBox(orientedBoundingBox);
    } else {
      // If our bounding rectangle spans >= 90º, we should use the entire globe as a bounding sphere.
      boundingSphere = new BoundingSphere(
        Cartesian3.ZERO,
        // radius (seems to be max height of Earth terrain?)
        6379792.481506292
      );
    }

    const triangles = new Uint16Array(mesh.triangles);

    // @ts-ignore

    // If our tile has greater than ~1º size
    if (tileRect.width > 0.02) {
      // We need to be able to specify a minimum number of triangles...
      return this.emptyHeightmap(64);
    }

    const quantizedVertices = new Uint16Array(
      //verts
      [...xvals, ...yvals, ...heights]
    );

    // SE NW NE
    // NE NW SE

    return new QuantizedMeshTerrainData({
      minimumHeight: minHeight,
      maximumHeight: maxHeight,
      quantizedVertices,
      indices: triangles,
      boundingSphere,
      orientedBoundingBox: orientedBoundingBox ?? undefined,
      horizonOcclusionPoint,
      westIndices,
      southIndices,
      eastIndices,
      northIndices,
      westSkirtHeight: skirtHeight,
      southSkirtHeight: skirtHeight,
      eastSkirtHeight: skirtHeight,
      northSkirtHeight: skirtHeight,
      childTileMask: 14,
    });
  }

  async requestTileGeometry(x: number, y: number, z: number) {
    const mx = this.tilingScheme.getNumberOfYTilesAtLevel(z);
    const err = this.getLevelMaximumGeometricError(z);

    const url = `https://cyberjapandata.gsi.go.jp/xyz/dem_png/${z}/${x}/${y}.png`;

    try {
      const pxArray = await this.getPixels(url);

      const terrain = gsiTerrainToGrid(pxArray);

      // set up mesh generator for a certain 2^k+1 grid size
      // generate RTIN hierarchy from terrain data (an array of size^2 length)
      const tile = this.martini.createTile(terrain);

      // get a mesh (vertices and triangles indices) for a 10m error
      console.log(`Error level: ${err}`);
      const mesh = tile.getMesh(err);

      return await this.createQuantizedMeshData(x, y, z, tile, mesh);
    } catch (err) {
      // We fall back to a heightmap
      const v = Math.max(32 - 4 * z, 4);
      return this.emptyHeightmap(v);
    }
  }

  getLevelMaximumGeometricError(level: any) {
    const levelZeroMaximumGeometricError =
      TerrainProvider.getEstimatedLevelZeroGeometricErrorForAHeightmap(
        this.tilingScheme.ellipsoid,
        65,
        this.tilingScheme.getNumberOfXTilesAtLevel(0)
      );

    // Scalar to control overzooming
    // also seems to control zooming for imagery layers
    const scalar = 4;

    return levelZeroMaximumGeometricError / (1 << level);
  }

  getTileDataAvailable(x: number, y: number, z: number) {
    return z <= 14;
  }
}

export default GsiTerrainProvider;
