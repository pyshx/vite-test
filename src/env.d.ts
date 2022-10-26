declare module "@mapbox/martini" {
  export default class Martini {
    constructor(gridSize = 257);
    createTile(terrain: ArrayLike<number>): Tile;
  }

  export class Tile {
    constructor(terrain: ArrayLike<number>, martini: Martini);
    update(): void;
    getMesh(maxError = 0): { vertices: Uint16Array; triangles: Uint32Array };
  }
}
