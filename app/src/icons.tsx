// Линейные значки из макета vacante 2.0: обводка 2 px, скруглённые концы, сетка 24×24.
import Svg, { Circle, Path, Rect } from 'react-native-svg';

export type IconName =
  | 'pin'
  | 'down'
  | 'back'
  | 'next'
  | 'heart'
  | 'share'
  | 'close'
  | 'calendar'
  | 'bell'
  | 'chat'
  | 'user'
  | 'shield'
  | 'map'
  | 'link'
  | 'undo'
  | 'home'
  | 'search'
  | 'clock';

const PATHS: Record<IconName, React.ReactNode> = {
  pin: (
    <>
      <Path d="M12 21s7-6.2 7-11a7 7 0 0 0-14 0c0 4.8 7 11 7 11z" />
      <Circle cx="12" cy="10" r="2.5" />
    </>
  ),
  down: <Path d="M6 9l6 6 6-6" />,
  back: <Path d="M15 6l-6 6 6 6" />,
  next: <Path d="M9 6l6 6-6 6" />,
  heart: <Path d="M12 21s-7-4.6-9-9a5 5 0 0 1 9-3 5 5 0 0 1 9 3c-2 4.4-9 9-9 9z" />,
  share: <Path d="M12 3v12M7 8l5-5 5 5M5 14v6h14v-6" />,
  close: <Path d="M6 6l12 12M18 6L6 18" />,
  calendar: (
    <>
      <Rect x="3" y="4" width="18" height="17" rx="2" />
      <Path d="M3 9h18M8 2v4M16 2v4M9 15l2 2 4-4" />
    </>
  ),
  bell: <Path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0" />,
  chat: <Path d="M21 12a8 8 0 0 1-8 8H8l-5 3 1.5-4.5A8 8 0 1 1 21 12z" />,
  user: (
    <>
      <Circle cx="12" cy="8" r="4" />
      <Path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
  shield: (
    <>
      <Path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />
      <Path d="M9 12l2 2 4-4" />
    </>
  ),
  map: <Path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2zM9 4v14M15 6v14" />,
  link: <Path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />,
  undo: <Path d="M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3" />,
  home: <Path d="M3 11l9-7 9 7M5 9.5V20h14V9.5" />,
  search: (
    <>
      <Circle cx="11" cy="11" r="7" />
      <Path d="M20 20l-3.5-3.5" />
    </>
  ),
  clock: (
    <>
      <Circle cx="12" cy="12" r="9" />
      <Path d="M12 7v5l3 2" />
    </>
  ),
};

export function Icon(props: { name: IconName; color: string; size?: number; width?: number; fill?: string }) {
  const { name, color, size = 24, width = 2, fill = 'none' } = props;
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill}
      stroke={color}
      strokeWidth={width}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {PATHS[name]}
    </Svg>
  );
}
