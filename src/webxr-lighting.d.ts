// WebXR Lighting Estimation API の型。@types/webxr に含まれていないので、使う分だけ宣言する。
// https://immersive-web.github.io/lighting-estimation/

interface XRLightProbe extends EventTarget {
  readonly probeSpace: XRSpace;
}

interface XRLightEstimate {
  /** 環境光を表す球面調和関数の係数 (RGB × 9 個) */
  readonly sphericalHarmonicsCoefficients: Float32Array;
  /** 主光源のある方向 */
  readonly primaryLightDirection: DOMPointReadOnly;
  /** 主光源の強さ (RGB) */
  readonly primaryLightIntensity: DOMPointReadOnly;
}

interface XRSession {
  requestLightProbe?(options?: { reflectionFormat?: 'srgba8' | 'rgba16f' }): Promise<XRLightProbe>;
}

interface XRFrame {
  getLightEstimate?(lightProbe: XRLightProbe): XRLightEstimate | null;
}
