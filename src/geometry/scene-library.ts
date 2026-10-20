// Furniture scenes shipped in public/scenes.
export interface SceneLibraryEntry {
  id: string;
  label: string;
  file: string;
  // room preset this scene is sized for (if not the default)
  roomPreset?: string;
}

export const NO_SCENE_OBJECTS_ID = 'none';

export const SCENE_LIBRARY: SceneLibraryEntry[] = [
  { id: NO_SCENE_OBJECTS_ID, label: 'None', file: '' },
  { id: 'furnished-room', label: 'Furnished Room', file: 'furnished-room.json' },
  { id: 'classroom-desks', label: 'Classroom Desks', file: 'classroom-desks.json' },
  { id: 'doorway-occluder', label: 'Doorway Occluder', file: 'doorway-occluder.json' },
  { id: 'l-shaped-room-divider', label: 'L-Shaped Divider', file: 'l-shaped-room-divider.json' },
  {
    id: 'cathedral-columns',
    label: 'Cathedral Columns (Cathedral)',
    file: 'cathedral-columns.json',
    roomPreset: 'CATHEDRAL',
  },
  {
    id: 'concert-hall-reflectors',
    label: 'Concert Hall Reflectors (Concert Hall)',
    file: 'concert-hall-reflectors.json',
    roomPreset: 'CONCERT_HALL',
  },
];
