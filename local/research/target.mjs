// Public, synthetic source-retrieval examples. They contain no user writing.
// The two query sets reference different documents; the labels stay in the
// trusted evaluator. Repeated runs reuse these public examples and do not
// establish performance on unseen screenplays.
export const target = {
  id: 'qiscreenwrite.synthetic-source-retrieval.v1',
  title: 'Screenplay source retrieval',
  description: 'Compare fixed search weights on synthetic screenplay evidence. Admission updates a separate research configuration only; the editor and creative analysis do not consume it.',
  baseline: { titleWeight: 1, textWeight: 0, tagWeight: 0 },
  candidates: [
    { titleWeight: 0, textWeight: 1, tagWeight: 0 },
    { titleWeight: 0, textWeight: 0, tagWeight: 1 },
    { titleWeight: 1, textWeight: 1, tagWeight: 0 },
    { titleWeight: 1, textWeight: 0, tagWeight: 1 },
    { titleWeight: 0, textWeight: 1, tagWeight: 1 },
    { titleWeight: 1, textWeight: 1, tagWeight: 1 },
    { titleWeight: 1, textWeight: 2, tagWeight: 1 },
    { titleWeight: 1, textWeight: 1, tagWeight: 2 },
  ],
  documents: [
    { id: 'development-01', title: 'Harbor departure', text: 'Mara hides a brass compass beneath the loose floorboard before sunrise.', tags: ['prop', 'compass', 'concealment'] },
    { id: 'development-02', title: 'The waiting room', text: 'A cracked violin case holds the missing railway tickets.', tags: ['prop', 'violin', 'tickets'] },
    { id: 'development-03', title: 'A late arrival', text: 'Jonah promises his sister that the blue lantern will remain lit.', tags: ['promise', 'lantern', 'sibling'] },
    { id: 'development-04', title: 'The narrow crossing', text: 'A storm has washed away the wooden bridge above the ravine.', tags: ['obstacle', 'bridge', 'storm'] },
    { id: 'development-05', title: 'Morning rehearsal', text: 'Lina repeats the secret phrase silver orchard to identify the courier.', tags: ['dialogue', 'password', 'courier'] },
    { id: 'development-06', title: 'The final invitation', text: 'The clockmaker leaves a copper key inside an envelope of violet paper.', tags: ['prop', 'key', 'envelope'] },
    { id: 'confirmation-01', title: 'A distant shore', text: 'Nora finds a porcelain bird wrapped in a wool scarf beside the empty berth.', tags: ['prop', 'bird', 'scarf'] },
    { id: 'confirmation-02', title: 'The old workshop', text: 'A red bicycle blocks the cellar stairs during the blackout.', tags: ['obstacle', 'bicycle', 'blackout'] },
    { id: 'confirmation-03', title: 'An unexpected guest', text: 'Ivo vows to return the amber necklace before the harvest festival.', tags: ['promise', 'necklace', 'festival'] },
    { id: 'confirmation-04', title: 'A change of plans', text: 'The messenger uses the phrase winter meadow to request safe passage.', tags: ['dialogue', 'password', 'passage'] },
    { id: 'confirmation-05', title: 'The quiet farewell', text: 'Sela buries a tin whistle under the apple tree to mark the meeting place.', tags: ['prop', 'whistle', 'meeting'] },
    { id: 'confirmation-06', title: 'Another beginning', text: 'A broken water pump forces the travelers to cross the salt flats.', tags: ['obstacle', 'pump', 'travel'] },
  ],
  development: [
    { id: 'development-query-01', query: 'brass compass floorboard', relevantIds: ['development-01'] },
    { id: 'development-query-02', query: 'violin railway tickets', relevantIds: ['development-02'] },
    { id: 'development-query-03', query: 'blue lantern sister', relevantIds: ['development-03'] },
    { id: 'development-query-04', query: 'storm wooden bridge', relevantIds: ['development-04'] },
    { id: 'development-query-05', query: 'silver orchard courier', relevantIds: ['development-05'] },
    { id: 'development-query-06', query: 'copper key violet envelope', relevantIds: ['development-06'] },
  ],
  confirmation: [
    { id: 'confirmation-query-01', query: 'porcelain bird wool scarf', relevantIds: ['confirmation-01'] },
    { id: 'confirmation-query-02', query: 'red bicycle blackout', relevantIds: ['confirmation-02'] },
    { id: 'confirmation-query-03', query: 'amber necklace harvest festival', relevantIds: ['confirmation-03'] },
    { id: 'confirmation-query-04', query: 'winter meadow safe passage', relevantIds: ['confirmation-04'] },
    { id: 'confirmation-query-05', query: 'tin whistle apple tree', relevantIds: ['confirmation-05'] },
    { id: 'confirmation-query-06', query: 'broken water pump salt flats', relevantIds: ['confirmation-06'] },
  ],
};
