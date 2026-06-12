
// You can write more code here

/* START OF COMPILED CODE */

/* START-USER-IMPORTS */
import { InteriorState, initInterior, setupInterior, updateInterior } from './InteriorHelper';
import { placeTownObject } from '../objects/TownObjects';
/* END-USER-IMPORTS */

export default class Library extends Phaser.Scene {

	constructor() {
		super("Library");

		/* START-USER-CTR-CODE */
		// Write your code here.
		/* END-USER-CTR-CODE */
	}

	editorCreate(): void {

		// libraryMap
		this.cache.tilemap.add("libraryMap_4dd6c18e-a092-4e3d-9638-82286bfea3dc", {
			format: 1,
			data: {
				width: 20,
				height: 16,
				orientation: "orthogonal",
				tilewidth: 16,
				tileheight: 16,
				tilesets: [
					{
						columns: 32,
						margin: 0,
						spacing: 0,
						tilewidth: 16,
						tileheight: 16,
						tilecount: 1280,
						firstgid: 1,
						image: "Room_Builder_Walls_16x16",
						name: "Room_Builder_Walls_16x16",
						imagewidth: 512,
						imageheight: 640,
					},
					{
						columns: 15,
						margin: 0,
						spacing: 0,
						tilewidth: 16,
						tileheight: 16,
						tilecount: 600,
						firstgid: 1281,
						image: "Room_Builder_Floors_16x16",
						name: "Room_Builder_Floors_16x16",
						imagewidth: 240,
						imageheight: 640,
					},
					{
						columns: 45,
						margin: 0,
						spacing: 0,
						tilewidth: 16,
						tileheight: 16,
						tilecount: 450,
						firstgid: 1881,
						image: "Room_Builder_borders_16x16",
						name: "Room_Builder_borders_16x16",
						imagewidth: 720,
						imageheight: 160,
					},
					{
						columns: 16,
						margin: 0,
						spacing: 0,
						tilewidth: 16,
						tileheight: 16,
						tilecount: 544,
						firstgid: 2331,
						image: "5_Classroom_and_library_Black_Shadow_16x16",
						name: "5_Classroom_and_library_Black_Shadow_16x16",
						imagewidth: 256,
						imageheight: 544,
					},
					{
						columns: 16,
						margin: 0,
						spacing: 0,
						tilewidth: 16,
						tileheight: 16,
						tilecount: 1952,
						firstgid: 2875,
						image: "22_Museum_Black_Shadow_16x16",
						name: "22_Museum_Black_Shadow_16x16",
						imagewidth: 256,
						imageheight: 1952,
					},
					{
						columns: 16,
						margin: 0,
						spacing: 0,
						tilewidth: 16,
						tileheight: 16,
						tilecount: 1248,
						firstgid: 4827,
						image: "1_Generic_Black_Shadow_16x16",
						name: "1_Generic_Black_Shadow_16x16",
						imagewidth: 256,
						imageheight: 1248,
					},
					{
						columns: 16,
						margin: 0,
						spacing: 0,
						tilewidth: 16,
						tileheight: 16,
						tilecount: 720,
						firstgid: 6075,
						image: "2_LivingRoom_Black_Shadow_16x16",
						name: "2_LivingRoom_Black_Shadow_16x16",
						imagewidth: 256,
						imageheight: 720,
					},
					{
						columns: 8,
						margin: 0,
						spacing: 0,
						tilewidth: 16,
						tileheight: 16,
						tilecount: 8,
						firstgid: 6795,
						image: "collisions_objects",
						name: "collisions_objects",
						imagewidth: 128,
						imageheight: 16,
					},
				],
				layers: [
					{
						type: "tilelayer",
						name: "floor",
						width: 20,
						height: 16,
						opacity: 1,
						data: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1701, 1702, 1702, 1702, 1702, 1702, 1702, 1702, 1702, 1702, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1716, 1717, 1717, 1717, 1717, 1717, 1717, 1717, 1717, 1717, 0, 0, 1701, 1702, 1702, 1702, 1702, 0, 0, 0, 1716, 1717, 1717, 1717, 1717, 1717, 1717, 1717, 1717, 1717, 0, 0, 1716, 1717, 1717, 1717, 1717, 0, 0, 0, 1716, 1717, 1717, 1717, 1717, 1717, 1717, 1717, 1717, 1717, 0, 0, 1716, 1717, 1717, 1717, 1717, 0, 0, 0, 1716, 1717, 1717, 1717, 1717, 1717, 1717, 1717, 1717, 1717, 0, 0, 1716, 1717, 1717, 1717, 1717, 0, 0, 0, 1716, 1717, 1717, 1717, 1717, 1717, 1717, 1717, 1717, 1717, 1702, 1702, 1703, 1717, 1717, 1717, 1717, 1702, 0, 0, 1716, 1717, 1717, 1717, 1717, 1717, 1717, 1717, 1717, 1717, 1717, 1717, 1717, 1717, 1717, 1717, 1717, 1717, 0, 0, 1716, 1717, 1717, 1717, 1717, 1717, 1717, 1717, 1717, 1717, 0, 0, 1717, 1717, 1717, 1717, 1717, 0, 0, 0, 1716, 1717, 1717, 1717, 1717, 1717, 1717, 1717, 1717, 1717, 0, 0, 1716, 1717, 1717, 1717, 1717, 0, 0, 0, 1716, 1717, 1717, 1717, 1717, 1717, 1717, 1717, 1717, 1717, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1716, 1717, 1717, 1717, 1717, 1717, 1717, 1717, 1717, 1717, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1716, 1717, 1717, 1717, 1717, 1717, 1717, 1717, 1717, 1717, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
					},
					{
						type: "tilelayer",
						name: "walls",
						width: 20,
						height: 16,
						opacity: 1,
						data: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2157, 13, 13, 13, 13, 13, 13, 13, 13, 13, 13, 2159, 0, 0, 0, 0, 0, 0, 0, 0, 2202, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 2204, 2157, 386, 386, 386, 386, 386, 2159, 0, 2202, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2204, 2202, 418, 418, 418, 418, 418, 2204, 0, 2202, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2204, 2202, 0, 0, 0, 0, 0, 2204, 0, 2202, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2204, 2202, 0, 0, 0, 0, 0, 2204, 0, 2202, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 385, 387, 0, 0, 0, 0, 0, 385, 2159, 2202, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 417, 419, 0, 0, 0, 0, 0, 417, 2204, 2202, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2204, 2202, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2204, 2202, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2197, 2196, 0, 0, 0, 0, 0, 2197, 2249, 2202, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2204, 2202, 0, 0, 0, 0, 0, 2204, 0, 2202, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2204, 2247, 2248, 2248, 2248, 2248, 2248, 2249, 0, 2202, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2204, 0, 0, 0, 0, 0, 0, 0, 0, 2202, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2204, 0, 0, 0, 0, 0, 0, 0, 0, 2247, 2248, 2248, 2248, 2248, 2248, 2248, 2248, 2248, 2248, 2248, 2249, 0, 0, 0, 0, 0, 0, 0, 0],
					},
					{
						type: "tilelayer",
						name: "furnitures",
						width: 20,
						height: 16,
						opacity: 1,
						data: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5527, 5528, 0, 0, 0, 0, 0, 2571, 2572, 2573, 0, 0, 2571, 2572, 2573, 0, 0, 0, 2514, 2515, 5543, 5544, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2530, 2531, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2347, 0, 0, 0, 0, 0, 0, 0, 2571, 2572, 2573, 0, 0, 2571, 2572, 2573, 0, 0, 0, 2971, 2972, 2973, 2974, 2975, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2427, 2428, 2987, 2988, 2989, 2990, 2991, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2571, 2572, 2573, 0, 0, 2571, 2572, 2573, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2358, 2359, 0, 2354, 2355, 2358, 2359, 0, 2354, 2355, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2374, 2375, 0, 2370, 2371, 2374, 2375, 0, 2370, 2371, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2358, 2359, 0, 2354, 2355, 2358, 2359, 0, 2354, 2355, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2374, 2375, 0, 2370, 2371, 2374, 2375, 0, 2370, 2371, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
					},
					{
						type: "tilelayer",
						name: "furnitureTops",
						width: 20,
						height: 16,
						opacity: 1,
						data: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2539, 2540, 2541, 0, 4868, 2539, 2540, 2541, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2555, 2556, 2557, 0, 4884, 2555, 2556, 2557, 0, 0, 0, 2498, 2499, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2539, 2540, 2541, 0, 0, 2539, 2540, 2541, 0, 0, 0, 2939, 2940, 2941, 2942, 2943, 0, 0, 0, 0, 2555, 2556, 2557, 0, 0, 2555, 2556, 2557, 0, 0, 0, 2955, 2956, 2957, 2958, 2959, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2539, 2540, 2541, 0, 0, 2539, 2540, 2541, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2555, 2556, 2557, 0, 0, 2555, 2556, 2557, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2342, 0, 0, 2338, 2339, 2342, 0, 0, 2338, 2339, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6203, 0, 0, 0, 0, 0, 0, 6087, 6524, 6525, 6526, 6087, 0, 0, 0, 2342, 0, 0, 2338, 2339, 2342, 0, 0, 2338, 2339, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
					},
					{
						type: "tilelayer",
						name: "collisions",
						width: 20,
						height: 16,
						opacity: 1,
						data: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6795, 6795, 6795, 6795, 6795, 6795, 6795, 6795, 6795, 6795, 6795, 6795, 0, 0, 0, 0, 0, 0, 0, 0, 6795, 6795, 6795, 6795, 6795, 6795, 6795, 6795, 6795, 6795, 6795, 6795, 6795, 6795, 6795, 6795, 6795, 6795, 6795, 0, 6795, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6795, 6795, 6795, 6795, 6795, 6795, 6795, 6795, 0, 6795, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6795, 6795, 0, 0, 0, 0, 0, 6795, 0, 6795, 0, 6795, 6795, 6795, 0, 0, 6795, 6795, 6795, 0, 6795, 6795, 0, 0, 0, 0, 0, 6795, 0, 6795, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6795, 6795, 6795, 6795, 6795, 6795, 6795, 6795, 6795, 6795, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6795, 6795, 0, 0, 0, 0, 0, 6795, 6795, 6795, 0, 6795, 6795, 6795, 0, 0, 6795, 6795, 6795, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6795, 6795, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6795, 6795, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6795, 6795, 0, 0, 0, 0, 0, 6795, 6795, 6795, 6795, 6795, 0, 6795, 6795, 6795, 6795, 0, 6795, 6795, 6795, 6795, 6795, 6795, 6795, 6795, 6795, 6795, 0, 6795, 6795, 0, 0, 0, 6795, 6795, 0, 0, 0, 6795, 6795, 6795, 6795, 6795, 6795, 6795, 6795, 6795, 0, 6795, 6795, 6795, 0, 6795, 6795, 6795, 6795, 0, 6795, 6795, 6795, 0, 0, 0, 0, 0, 0, 0, 0, 6795, 6795, 0, 0, 0, 6795, 6795, 0, 0, 0, 6795, 6795, 0, 0, 0, 0, 0, 0, 0, 0, 6795, 6795, 6795, 6795, 6795, 6795, 6795, 6795, 6795, 6795, 6795, 6795, 0, 0, 0, 0, 0, 0, 0, 0],
					},
					{
						type: "tilelayer",
						name: "spawns",
						width: 20,
						height: 16,
						opacity: 1,
						data: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
					},
				],
			},
		});
		const libraryMap = this.add.tilemap("libraryMap_4dd6c18e-a092-4e3d-9638-82286bfea3dc");
		libraryMap.addTilesetImage("Room_Builder_Walls_16x16");
		libraryMap.addTilesetImage("Room_Builder_Floors_16x16");
		libraryMap.addTilesetImage("Room_Builder_borders_16x16");
		libraryMap.addTilesetImage("5_Classroom_and_library_Black_Shadow_16x16");
		libraryMap.addTilesetImage("22_Museum_Black_Shadow_16x16");
		libraryMap.addTilesetImage("1_Generic_Black_Shadow_16x16");
		libraryMap.addTilesetImage("2_LivingRoom_Black_Shadow_16x16");
		libraryMap.addTilesetImage("collisions_objects");

		// floor
		libraryMap.createLayer("floor", ["Room_Builder_Floors_16x16"], 0, 0);

		// walls
		libraryMap.createLayer("walls", ["Room_Builder_borders_16x16","Room_Builder_Walls_16x16"], 0, 0);

		// furnitures
		libraryMap.createLayer("furnitures", ["1_Generic_Black_Shadow_16x16","5_Classroom_and_library_Black_Shadow_16x16","22_Museum_Black_Shadow_16x16"], 0, 0);

		// furnitureTops
		libraryMap.createLayer("furnitureTops", ["5_Classroom_and_library_Black_Shadow_16x16","1_Generic_Black_Shadow_16x16","22_Museum_Black_Shadow_16x16","2_LivingRoom_Black_Shadow_16x16"], 0, 0);

		// collisions
		libraryMap.createLayer("collisions", ["collisions_objects"], 0, 0);

		// spawns
		libraryMap.createLayer("spawns", [], 0, 0);

		this.libraryMap = libraryMap;

		this.events.emit("scene-awake");
	}

	private libraryMap!: Phaser.Tilemaps.Tilemap;

	/* START-USER-CODE */

	private state: InteriorState = {} as InteriorState;

	init(data: { returnX?: number; returnY?: number; visitorName?: string }) {
		initInterior(this, data, this.state);
	}

	create() {
		this.editorCreate();
		setupInterior(this, this.libraryMap, 'researcher', { x: 96, y: 144 }, 'The Library', this.state);
		// The reading lamp (world fixture: agents flicker it for effect) on the
		// reading table by the nook. Position via render_map.py.
		const lamp = placeTownObject(this, 'table-lamp-beige-lit', 95, 180, { depth: 20 });
		if (lamp) this.state.fixtures?.register('library', 'lamp', lamp);
	}

	update() {
		updateInterior(this.state);
	}

	/* END-USER-CODE */
}

/* END OF COMPILED CODE */

// You can write more code here
