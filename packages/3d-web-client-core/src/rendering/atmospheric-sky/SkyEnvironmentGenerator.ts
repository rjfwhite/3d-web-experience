import {
  CubeCamera,
  HalfFloatType,
  LinearMipmapLinearFilter,
  LinearFilter,
  LinearSRGBColorSpace,
  Object3D,
  RGBAFormat,
  Scene,
  WebGLCubeRenderTarget,
  WebGLRenderer,
  Vector3,
} from "three";

import { Sky } from "./Sky";

/**
 * Generates an environment map from a Sky object
 */
export class SkyEnvironmentGenerator {
  private renderer: WebGLRenderer;
  private cubeCamera: CubeCamera | null = null;
  private renderTarget: WebGLCubeRenderTarget | null = null;

  constructor(renderer: WebGLRenderer) {
    this.renderer = renderer;
  }

  /**
   * Generate environment map from sky
   * @param sky - The sky object to generate environment from
   * @param scene - Scene containing the sky
   * @param size - Size of the cubemap (default: 512)
   * @returns The generated environment map
   */
  generateEnvironmentMap(sky: Sky, scene: Scene, cameraPosition: Vector3): WebGLCubeRenderTarget {
    // Create render target if it doesn't exist or size changed
    if (!this.renderTarget || this.renderTarget.width !== 512) {
      if (this.renderTarget) {
        this.renderTarget.dispose();
      }

      this.renderTarget = new WebGLCubeRenderTarget(512, {
        type: HalfFloatType,
        format: RGBAFormat,
        colorSpace: LinearSRGBColorSpace,
        generateMipmaps: true,
        minFilter: LinearMipmapLinearFilter,
        magFilter: LinearFilter,
      });

      this.cubeCamera = new CubeCamera(0.1, 1000, this.renderTarget);
    }

    // Position the cube camera at origin
    this.cubeCamera!.position.copy(cameraPosition);

    // Temporarily hide all objects except the sky for environment map generation
    const originalVisible: boolean[] = [];
    scene.children.forEach((child: Object3D, index: number) => {
      if (child !== sky) {
        originalVisible[index] = child.visible;
        child.visible = false;
      }
    });

    // Render the environment map
    this.cubeCamera!.update(this.renderer, scene);

    // Restore original visibility
    scene.children.forEach((child: Object3D, index: number) => {
      if (child !== sky && originalVisible[index] !== undefined) {
        child.visible = originalVisible[index];
      }
    });

    return this.renderTarget;
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    if (this.renderTarget) {
      this.renderTarget.dispose();
    }
  }
} 