import { NPCConfig } from '@/lib/types';

// Static display + canvas data for each agent facet. Behavior is LIVE now —
// status, activity, engagement, thoughts, speech, and chat replies all arrive
// from the world server via WorldClient. The old scripted fields (greeting,
// status, stubbedResponses) were removed with the simulator trio.
export const NPC_CONFIGS: Record<string, NPCConfig> = {
  career: {
    id: 'career',
    displayName: 'Career Thomas',
    sprite: 'thomas-career',
    homeBuilding: 'office',
    homePosition: { x: 432, y: 220 },
    color: '#4A90D9',
    waypoints: [
      { x: 432, y: 220 },
      { x: 370, y: 260 },
      { x: 320, y: 300 },
      { x: 432, y: 220 },
    ],
    aboutText: "Career Thomas tracks Thomas's professional journey — from studying statistics at BYU to building AI infrastructure at SambaNova Systems to founding Billables AI. Ask him about career transitions, the AI industry, or what it's like building a startup.",
  },
  researcher: {
    id: 'researcher',
    displayName: 'Researcher Thomas',
    sprite: 'thomas-researcher',
    homeBuilding: 'library',
    homePosition: { x: 160, y: 190 },
    color: '#9B59B6',
    waypoints: [
      { x: 160, y: 190 },
      { x: 200, y: 260 },
      { x: 120, y: 300 },
      { x: 160, y: 190 },
    ],
    aboutText: "Researcher Thomas represents the analytical side — deep into statistics, ML evaluation, and scientific rigor. He's always reading papers, questioning benchmarks, and thinking about how to properly measure AI capabilities.",
  },
  builder: {
    id: 'builder',
    displayName: 'Builder Thomas',
    sprite: 'thomas-builder',
    homeBuilding: 'workshop',
    homePosition: { x: 520, y: 220 },
    color: '#E67E22',
    waypoints: [
      { x: 520, y: 220 },
      { x: 480, y: 280 },
      { x: 420, y: 320 },
      { x: 520, y: 220 },
    ],
    aboutText: "Builder Thomas is the maker — always prototyping, shipping, and iterating. From Codenames eval tools to this very town, he's got multiple projects running at once. Ask him about what he's building or his approach to rapid development.",
  },
  writer: {
    id: 'writer',
    displayName: 'Writer Thomas',
    sprite: 'thomas-writer',
    homeBuilding: 'cafe',
    homePosition: { x: 240, y: 380 },
    color: '#27AE60',
    waypoints: [
      { x: 240, y: 380 },
      { x: 300, y: 400 },
      { x: 200, y: 420 },
      { x: 240, y: 380 },
    ],
    aboutText: "Writer Thomas turns complex ideas into clear narratives. He writes about AI, law, technology ethics, and the future of professional services. Find him at the cafe with a notebook and strong opinions about good prose.",
  },
  hobby: {
    id: 'hobby',
    displayName: 'Hobby Thomas',
    sprite: 'thomas-hobby',
    homeBuilding: 'park',
    homePosition: { x: 320, y: 350 },
    color: '#E74C3C',
    waypoints: [
      { x: 320, y: 350 },
      { x: 250, y: 380 },
      { x: 380, y: 400 },
      { x: 320, y: 350 },
    ],
    aboutText: "Hobby Thomas is the fun side — board games, hiking, volleyball, cooking. He keeps the other Thomases grounded and reminds everyone that life is more than code and deadlines.",
  },
};
