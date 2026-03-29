import { SimulatedAction, ThomasId } from '@/lib/types';

export const SIMULATION_SCRIPTS: Record<ThomasId, SimulatedAction[]> = {
  career: [
    { type: 'think', thought: 'Time to review the quarterly goals...' },
    { type: 'work', description: 'Updating the career roadmap' },
    { type: 'think', thought: 'The AI billing space is evolving fast.' },
    { type: 'idle', duration: 5000 },
    { type: 'think', thought: 'Should schedule a sync with Builder Thomas about the demo.' },
    { type: 'say', message: 'Hey Builder Thomas, how\'s the demo coming along?', audience: 'builder' },
    { type: 'work', description: 'Reviewing candidate resumes' },
    { type: 'think', thought: 'Building great teams is an underrated skill.' },
    { type: 'idle', duration: 3000 },
    { type: 'think', thought: 'I wonder what Writer Thomas is drafting today.' },
  ],

  researcher: [
    { type: 'think', thought: 'This Monte Carlo convergence rate is fascinating...' },
    { type: 'work', description: 'Reading papers on Bayesian optimization' },
    { type: 'think', thought: 'The variance in these estimates is too high. Need a better prior.' },
    { type: 'idle', duration: 4000 },
    { type: 'say', message: 'Builder Thomas, your eval metrics might benefit from stratified sampling.', audience: 'builder' },
    { type: 'think', thought: 'I should write up these findings...' },
    { type: 'work', description: 'Deriving confidence intervals for LLM benchmarks' },
    { type: 'think', thought: 'Most people misunderstand what statistical significance means.' },
    { type: 'idle', duration: 5000 },
    { type: 'think', thought: 'Perhaps a Dirichlet process mixture would model this better.' },
  ],

  builder: [
    { type: 'think', thought: 'Time to check on the Codenames eval...' },
    { type: 'work', description: 'Running evaluation batch' },
    { type: 'think', thought: 'Hmm, accuracy dropped 2%. Need to investigate.' },
    { type: 'say', message: 'Hey Researcher Thomas, got a minute? The eval numbers look weird.', audience: 'researcher' },
    { type: 'idle', duration: 3000 },
    { type: 'work', description: 'Debugging the prompt template' },
    { type: 'think', thought: 'Found it! The system prompt was getting truncated.' },
    { type: 'work', description: 'Shipping the fix and re-running' },
    { type: 'think', thought: 'This town project is coming along nicely too.' },
    { type: 'idle', duration: 4000 },
  ],

  writer: [
    { type: 'think', thought: 'How do I frame the AI-in-law argument...' },
    { type: 'work', description: 'Drafting "The Future of AI in Legal Billing"' },
    { type: 'think', thought: 'The key tension is efficiency vs. accountability.' },
    { type: 'idle', duration: 5000 },
    { type: 'say', message: 'Career Thomas, can I interview you for my piece on AI leadership?', audience: 'career' },
    { type: 'work', description: 'Editing the third paragraph' },
    { type: 'think', thought: 'This needs a stronger opening hook.' },
    { type: 'work', description: 'Researching competitive landscape for context' },
    { type: 'idle', duration: 3000 },
    { type: 'think', thought: 'Good writing is rewriting. One more pass.' },
  ],

  hobby: [
    { type: 'think', thought: 'Beautiful day for a walk around town!' },
    { type: 'idle', duration: 3000 },
    { type: 'think', thought: 'I wonder if anyone wants to play Codenames later.' },
    { type: 'say', message: 'Anyone up for a game tonight?', audience: 'public' },
    { type: 'idle', duration: 4000 },
    { type: 'think', thought: 'That new pasta recipe turned out amazing.' },
    { type: 'think', thought: 'Should organize a team volleyball game soon.' },
    { type: 'idle', duration: 5000 },
    { type: 'think', thought: 'Builder Thomas has been in the workshop all day. I should check on him.' },
    { type: 'say', message: 'Hey Builder Thomas, take a break! Let\'s go for a walk.', audience: 'builder' },
  ],
};
