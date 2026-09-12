export type GalleryExample = { id: string; name: string; description: string; seconds: string; tokens: string; url?: string };
export const gallerySeeds: GalleryExample[] = [
  { id: 'gpt-6-astra', name: 'gpt-6-astra', description: 'A coastal ride, with a helmet and scarf.', seconds: '178.6', tokens: '6,478' },
  { id: 'gpt-5.6-sol', name: 'gpt-5.6-sol', description: 'A bright sky and a bold red bicycle.', seconds: '55.6', tokens: '5,406' },
  { id: 'claude-opus-5', name: 'claude-opus-5', description: 'Another take on the same cycling challenge.', seconds: '142.2', tokens: '12,013' },
];
