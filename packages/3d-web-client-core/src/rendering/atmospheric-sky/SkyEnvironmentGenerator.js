import * as THREE from "three";

/**
 * Generates an environment map from a Sky object
 */
export class SkyEnvironmentGenerator {
  constructor(renderer) {
    this.renderer = renderer;
    this.cubeCamera = null;
    this.renderTarget = null;
  }

  /**
   * Generate environment map from sky
   * @param {Sky} sky - The sky object to generate environment from
   * @param {THREE.Scene} scene - Scene containing the sky
   * @param {THREE.Vector3} cameraPosition - Position to generate environment map from
   * @param {number} size - Size of the cubemap (default: 512)
   * @returns {THREE.WebGLCubeRenderTarget} The generated environment map
   */
  generateEnvironmentMap(sky, scene, cameraPosition, size = 512) {
    // Create render target if it doesn't exist or size changed
    if (!this.renderTarget || this.renderTarget.width !== size) {
      if (this.renderTarget) {
        this.renderTarget.dispose();
      }

      this.renderTarget = new THREE.WebGLCubeRenderTarget(size, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        colorSpace: THREE.LinearSRGBColorSpace,
        generateMipmaps: true,
        minFilter: THREE.LinearMipmapLinearFilter,
        magFilter: THREE.LinearFilter,
      });

      this.cubeCamera = new THREE.CubeCamera(0.1, 1000, this.renderTarget);
    }

    // Position the cube camera at the provided camera position
    this.cubeCamera.position.copy(cameraPosition);

    //Temporarily hide all objects except the sky for environment map generation
    const originalVisible = [];
    scene.children.forEach((child, index) => {
      if (child !== sky) {
        originalVisible[index] = child.visible;
        child.visible = false;
      }
    });

    // Render the environment map

    this.cubeCamera.update(this.renderer, scene);

    // Restore original visibility
    scene.children.forEach((child, index) => {
      if (child !== sky && originalVisible[index] !== undefined) {
        child.visible = originalVisible[index];
      }
    });

    return this.renderTarget;
  }

  /**
   * Dispose of resources
   */
  dispose() {
    if (this.renderTarget) {
      this.renderTarget.dispose();
    }
  }
}
