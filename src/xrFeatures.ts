/** セッション開始時に要求する WebXR の機能と、このデモでの用途。 */
export interface XRFeatureInfo {
  id: string;
  label: string;
  use: string;
}

export const REQUIRED_FEATURES: XRFeatureInfo[] = [
  { id: 'local-floor', label: '床基準の座標系', use: '床を y=0 とした座標で物を置く' },
];

export const OPTIONAL_FEATURES: XRFeatureInfo[] = [
  { id: 'hand-tracking', label: 'ハンドトラッキング', use: '手でつかむ・描く・ボタンを押す' },
  { id: 'plane-detection', label: '平面検出', use: '床・壁・机の可視化と、物理の当たり判定' },
  { id: 'mesh-detection', label: 'メッシュ検出', use: '部屋の形状の可視化と、物理の当たり判定' },
  { id: 'hit-test', label: 'ヒットテスト', use: 'レイで指した現実の面に物を置く' },
  { id: 'anchors', label: 'アンカー', use: '置いた物を現実の位置に固定し、次回も復元する' },
  { id: 'depth-sensing', label: '深度センシング', use: '現実の物や手で仮想物体を隠す。動いた物の当たり判定' },
  { id: 'light-estimation', label: '光源推定', use: '部屋の明るさに照明を合わせる' },
];

export const ALL_FEATURES = [...REQUIRED_FEATURES, ...OPTIONAL_FEATURES];
