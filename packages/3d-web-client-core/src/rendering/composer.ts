import { HDRJPGLoader } from "@monogrid/gainmap-js";
import {
  BlendFunction,
  BloomEffect,
  EdgeDetectionMode,
  EffectComposer,
  EffectPass,
  FXAAEffect,
  NormalPass,
  PredicationMode,
  RenderPass,
  ShaderPass,
  SMAAEffect,
  SMAAPreset,
  SSAOEffect,
  TextureEffect,
  ToneMappingEffect,
} from "postprocessing";
import {
  ACESFilmicToneMapping,
  AmbientLight,
  Color,
  EquirectangularReflectionMapping,
  Euler,
  Fog,
  HalfFloatType,
  LinearSRGBColorSpace,
  LoadingManager,
  MathUtils,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  ShadowMapType,
  SRGBColorSpace,
  Texture,
  ToneMapping,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { RGBELoader } from "three/examples/jsm/loaders/RGBELoader.js";

import { CameraManager } from "../camera/CameraManager";
import { Sun } from "../sun/Sun";
import { TimeManager } from "../time/TimeManager";
import { bcsValues } from "../tweakpane/blades/bcsFolder";
import { envValues, sunValues } from "../tweakpane/blades/environmentFolder";
import { extrasValues } from "../tweakpane/blades/postExtrasFolder";
import { rendererValues } from "../tweakpane/blades/rendererFolder";
import { n8ssaoValues, ppssaoValues } from "../tweakpane/blades/ssaoFolder";
import { toneMappingValues } from "../tweakpane/blades/toneMappingFolder";
import { TweakPane } from "../tweakpane/TweakPane";

import { Sky } from "./atmospheric-sky/Sky";
import { SkyEnvironmentGenerator } from "./atmospheric-sky/SkyEnvironmentGenerator";
import { BrightnessContrastSaturation } from "./post-effects/bright-contrast-sat";
import { GaussGrainEffect } from "./post-effects/gauss-grain";
import { N8SSAOPass } from "./post-effects/n8-ssao/N8SSAOPass";

type ComposerContructorArgs = {
  scene: Scene;
  cameraManager: CameraManager;
  spawnSun: boolean;
  environmentConfiguration?: EnvironmentConfiguration;
};

export type EnvironmentConfiguration = {
  groundPlane?: boolean;
  skybox?: {
    intensity?: number;
    blurriness?: number;
    azimuthalAngle?: number;
    polarAngle?: number;
  } & (
    | {
        hdrJpgUrl: string;
      }
    | {
        hdrUrl: string;
      }
    | {
        atmospheric?: {
          turbidity?: number;
          rayleigh?: number;
          mieCoefficient?: number;
          mieDirectionalG?: number;
          sunPosition?: Vector3;
        };
      }
  );
  envMap?: {
    intensity?: number;
  };
  sun?: {
    intensity?: number;
    polarAngle?: number;
    azimuthalAngle?: number;
    tracking?: {
      enabled?: boolean;
      speed?: number;
      cycleDuration?: number;
    };
  };
  fog?: {
    fogNear?: number;
    fogFar?: number;
    fogColor?: {
      r: number;
      g: number;
      b: number;
    };
  };
  postProcessing?: {
    bloomIntensity?: number;
  };
  ambientLight?: {
    intensity?: number;
  };
};

export class Composer {
  private width: number = 1;
  private height: number = 1;
  private resizeListener: () => void;
  public resolution: Vector2 = new Vector2(this.width, this.height);

  private readonly scene: Scene;
  public postPostScene: Scene;
  private readonly cameraManager: CameraManager;
  public readonly renderer: WebGLRenderer;

  public readonly effectComposer: EffectComposer;
  private readonly renderPass: RenderPass;

  private readonly normalPass: NormalPass;
  private readonly normalTextureEffect: TextureEffect;
  private readonly ppssaoEffect: SSAOEffect;
  private readonly ppssaoPass: EffectPass;
  private readonly n8aopass: N8SSAOPass;

  private readonly fxaaEffect: FXAAEffect;
  private readonly fxaaPass: EffectPass;
  private readonly bloomEffect: BloomEffect;
  private readonly bloomPass: EffectPass;
  private readonly toneMappingEffect: ToneMappingEffect;
  private readonly smaaEffect: SMAAEffect;

  private readonly toneMappingPass: EffectPass;
  private readonly smaaPass: EffectPass;

  private readonly bcs = BrightnessContrastSaturation;
  private readonly bcsPass: ShaderPass;

  private readonly gaussGrainEffect = GaussGrainEffect;
  private readonly gaussGrainPass: ShaderPass;

  private ambientLight: AmbientLight | null = null;
  private environmentConfiguration?: EnvironmentConfiguration;

  private skyboxState: {
    src: {
      hdrJpgUrl?: string;
      hdrUrl?: string;
    };
    latestPromise: Promise<unknown> | null;
  } = { src: {}, latestPromise: null };

  // Atmospheric Sky System
  private sky: Sky | null = null;
  private skyEnvironmentGenerator: SkyEnvironmentGenerator | null = null;

  public sun: Sun | null = null;
  public spawnSun: boolean;

  // Sun tracking system
  private sunTrackingEnabled: boolean = false;
  private sunTrackingSpeed: number = 0.01; // Speed multiplier for sun movement (increased from 0.1)
  private sunCycleDuration: number = 30; // Duration of full sun cycle in seconds (reduced from 60)
  private sunStartTime: number = 0; // Time when sun tracking started

  constructor({
    scene,
    cameraManager,
    spawnSun = false,
    environmentConfiguration,
  }: ComposerContructorArgs) {
    this.scene = scene;
    this.cameraManager = cameraManager;
    this.postPostScene = new Scene();
    this.spawnSun = spawnSun;
    this.renderer = new WebGLRenderer({
      powerPreference: "high-performance",
      antialias: true,
    });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.info.autoReset = false;
    this.renderer.setSize(this.width, this.height);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = rendererValues.shadowMap as ShadowMapType;
    this.renderer.toneMapping = rendererValues.toneMapping as ToneMapping;
    this.renderer.toneMappingExposure = rendererValues.exposure;

    this.environmentConfiguration = environmentConfiguration;

    this.effectComposer = new EffectComposer(this.renderer, {
      frameBufferType: HalfFloatType,
    });

    this.renderPass = new RenderPass(this.scene, this.cameraManager.activeCamera);

    this.normalPass = new NormalPass(this.scene, this.cameraManager.activeCamera);
    this.normalPass.enabled = ppssaoValues.enabled;
    this.normalTextureEffect = new TextureEffect({
      blendFunction: BlendFunction.SKIP,
      texture: this.normalPass.texture,
    });

    this.ppssaoEffect = new SSAOEffect(this.cameraManager.activeCamera, this.normalPass.texture, {
      blendFunction: ppssaoValues.blendFunction,
      distanceScaling: ppssaoValues.distanceScaling,
      depthAwareUpsampling: ppssaoValues.depthAwareUpsampling,
      samples: ppssaoValues.samples,
      rings: ppssaoValues.rings,
      luminanceInfluence: ppssaoValues.luminanceInfluence,
      radius: ppssaoValues.radius,
      intensity: ppssaoValues.intensity,
      bias: ppssaoValues.bias,
      fade: ppssaoValues.fade,
      resolutionScale: ppssaoValues.resolutionScale,
      color: new Color().setRGB(ppssaoValues.color.r, ppssaoValues.color.g, ppssaoValues.color.b),
      worldDistanceThreshold: ppssaoValues.worldDistanceThreshold,
      worldDistanceFalloff: ppssaoValues.worldDistanceFalloff,
      worldProximityThreshold: ppssaoValues.worldProximityThreshold,
      worldProximityFalloff: ppssaoValues.worldProximityFalloff,
    });
    this.ppssaoPass = new EffectPass(
      this.cameraManager.activeCamera,
      this.ppssaoEffect,
      this.normalTextureEffect,
    );
    this.ppssaoPass.enabled = ppssaoValues.enabled;

    this.fxaaEffect = new FXAAEffect();

    if (environmentConfiguration?.postProcessing?.bloomIntensity) {
      extrasValues.bloom = environmentConfiguration.postProcessing.bloomIntensity;
    }

    this.updateSkyboxAndEnvValues();
    this.updateAmbientLightValues();
    this.updateFogValues();

    this.bloomEffect = new BloomEffect({
      intensity: extrasValues.bloom,
    });

    this.n8aopass = new N8SSAOPass(
      this.scene,
      this.cameraManager.activeCamera,
      this.width,
      this.height,
    );
    this.n8aopass.configuration.aoRadius = n8ssaoValues.aoRadius;
    this.n8aopass.configuration.distanceFalloff = n8ssaoValues.distanceFalloff;
    this.n8aopass.configuration.intensity = n8ssaoValues.intensity;
    this.n8aopass.configuration.color = new Color().setRGB(
      n8ssaoValues.color.r,
      n8ssaoValues.color.g,
      n8ssaoValues.color.b,
    );
    this.n8aopass.configuration.aoSamples = n8ssaoValues.aoSamples;
    this.n8aopass.configuration.denoiseSamples = n8ssaoValues.denoiseSamples;
    this.n8aopass.configuration.denoiseRadius = n8ssaoValues.denoiseRadius;
    this.n8aopass.enabled = n8ssaoValues.enabled;

    this.fxaaPass = new EffectPass(this.cameraManager.activeCamera, this.fxaaEffect);
    this.bloomPass = new EffectPass(this.cameraManager.activeCamera, this.bloomEffect);

    this.toneMappingEffect = new ToneMappingEffect({
      mode: toneMappingValues.mode,
      resolution: toneMappingValues.resolution,
      whitePoint: toneMappingValues.whitePoint,
      middleGrey: toneMappingValues.middleGrey,
      minLuminance: toneMappingValues.minLuminance,
      averageLuminance: toneMappingValues.averageLuminance,
      adaptationRate: toneMappingValues.adaptationRate,
    });
    this.smaaEffect = new SMAAEffect({
      preset: SMAAPreset.ULTRA,
      edgeDetectionMode: EdgeDetectionMode.COLOR,
      predicationMode: PredicationMode.DEPTH,
    });

    this.toneMappingPass = new EffectPass(this.cameraManager.activeCamera, this.toneMappingEffect);
    this.toneMappingPass.enabled =
      rendererValues.toneMapping === 5 || rendererValues.toneMapping === 0 ? true : false;

    this.bcsPass = new ShaderPass(this.bcs, "tDiffuse");
    this.bcs.uniforms.brightness.value = bcsValues.brightness;
    this.bcs.uniforms.contrast.value = bcsValues.contrast;
    this.bcs.uniforms.saturation.value = bcsValues.saturation;

    this.gaussGrainPass = new ShaderPass(this.gaussGrainEffect, "tDiffuse");
    this.gaussGrainEffect.uniforms.amount.value = extrasValues.grain;
    this.gaussGrainEffect.uniforms.alpha.value = 1.0;

    this.smaaPass = new EffectPass(this.cameraManager.activeCamera, this.smaaEffect);

    this.effectComposer.addPass(this.renderPass);
    if (ppssaoValues.enabled) {
      this.effectComposer.addPass(this.normalPass);
      this.effectComposer.addPass(this.ppssaoPass);
    }
    if (n8ssaoValues.enabled) {
      this.effectComposer.addPass(this.n8aopass);
    }
    this.effectComposer.addPass(this.fxaaPass);
    this.effectComposer.addPass(this.bloomPass);
    this.effectComposer.addPass(this.toneMappingPass);
    this.effectComposer.addPass(this.bcsPass);
    this.effectComposer.addPass(this.gaussGrainPass);

    if (this.spawnSun === true) {
      this.sun = new Sun();
      this.scene.add(this.sun);
      
      // Configure sun tracking based on environment configuration
      const sunTrackingConfig = this.environmentConfiguration?.sun?.tracking;
      const trackingEnabled = sunTrackingConfig?.enabled !== false; // Default to true
      const trackingSpeed = sunTrackingConfig?.speed ?? 1.0; // Faster default speed
      const cycleDuration = sunTrackingConfig?.cycleDuration ?? 10; // Shorter default cycle
      
      if (trackingEnabled) {
        this.enableSunTracking(trackingSpeed, cycleDuration);
      }
    }

    // Initialize atmospheric sky system
    this.skyEnvironmentGenerator = new SkyEnvironmentGenerator(this.renderer);
    this.initializeAtmosphericSky();

    if (this.environmentConfiguration?.skybox) {
      if ("hdrJpgUrl" in this.environmentConfiguration.skybox) {
        this.useHDRJPG(this.environmentConfiguration.skybox.hdrJpgUrl);
      } else if ("hdrUrl" in this.environmentConfiguration.skybox) {
        this.useHDRI(this.environmentConfiguration.skybox.hdrUrl);
      } else if ("atmospheric" in this.environmentConfiguration.skybox) {
        this.updateAtmosphericSky();
      }
    } else {
      // Default to atmospheric sky if no skybox configuration is provided
      this.updateAtmosphericSky();
    }

    this.updateSunValues();

    this.resizeListener = () => {
      this.fitContainer();
    };
    window.addEventListener("resize", this.resizeListener, false);
    this.fitContainer();
  }

  public updateEnvironmentConfiguration(environmentConfiguration: EnvironmentConfiguration) {
    this.environmentConfiguration = environmentConfiguration;

    if (environmentConfiguration.skybox) {
      if ("hdrJpgUrl" in environmentConfiguration.skybox) {
        this.useHDRJPG(environmentConfiguration.skybox.hdrJpgUrl);
      } else if ("hdrUrl" in environmentConfiguration.skybox) {
        this.useHDRI(environmentConfiguration.skybox.hdrUrl);
      } else if ("atmospheric" in environmentConfiguration.skybox) {
        this.updateAtmosphericSky();
      }
    } else {
      // Default to atmospheric sky if no skybox configuration is provided
      this.updateAtmosphericSky();
    }

    this.updateSkyboxAndEnvValues();
    this.updateAmbientLightValues();
    this.updateBloomValues();
    this.updateSunValues();
    this.updateFogValues();
  }

  public setupTweakPane(tweakPane: TweakPane) {
    tweakPane.setupRenderPane(
      this.effectComposer,
      this.normalPass,
      this.ppssaoEffect,
      this.ppssaoPass,
      this.n8aopass,
      this.toneMappingEffect,
      this.toneMappingPass,
      this.bcs,
      this.bloomEffect,
      this.gaussGrainEffect,
      this.spawnSun,
      this.sun,
      this.setHDRIFromFile.bind(this),
      (azimuthalAngle: number) => {
        envValues.skyboxAzimuthalAngle = azimuthalAngle;
        this.updateSkyboxRotation();
      },
      (polarAngle: number) => {
        envValues.skyboxPolarAngle = polarAngle;
        this.updateSkyboxRotation();
      },
      this.setAmbientLight.bind(this),
      this.setFog.bind(this),
      this.updateAtmosphericSky.bind(this),
      this.syncSunWithSky.bind(this),
    );
  }

  public dispose() {
    window.removeEventListener("resize", this.resizeListener);
    if (this.skyEnvironmentGenerator) {
      this.skyEnvironmentGenerator.dispose();
    }
    if (this.sky) {
      this.scene.remove(this.sky);
    }
    this.renderer.dispose();
  }

  public fitContainer() {
    if (!this) {
      console.error("Composer not initialized");
      return;
    }
    const parentElement = this.renderer.domElement.parentNode as HTMLElement;
    if (!parentElement) {
      return;
    }
    this.width = parentElement.clientWidth;
    this.height = parentElement.clientHeight;
    this.cameraManager.activeCamera.aspect = this.width / this.height;
    this.cameraManager.activeCamera.updateProjectionMatrix();
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.resolution.set(
      this.width * window.devicePixelRatio,
      this.height * window.devicePixelRatio,
    );
    this.effectComposer.setSize(
      this.width / window.devicePixelRatio,
      this.height / window.devicePixelRatio,
    );
    this.renderPass.setSize(this.width, this.height);
    if (ppssaoValues.enabled) {
      this.normalPass.setSize(this.width, this.height);
      this.normalTextureEffect.setSize(this.width, this.height);
      this.ppssaoPass.setSize(this.width, this.height);
    }
    if (n8ssaoValues.enabled) {
      this.n8aopass.setSize(this.width, this.height);
    }
    this.fxaaPass.setSize(this.width, this.height);
    this.smaaPass.setSize(this.width, this.height);
    this.bloomPass.setSize(this.width, this.height);
    this.toneMappingPass.setSize(this.width, this.height);
    this.gaussGrainPass.setSize(this.width, this.height);
    this.gaussGrainEffect.uniforms.resolution.value = new Vector2(this.width, this.height);
    this.renderer.setSize(this.width, this.height);
  }

  public render(timeManager: TimeManager): void {
    // Update sun tracking if enabled
    if (this.sunTrackingEnabled && this.sun) {
      this.updateSunTracking(timeManager.time);
    }

    this.renderer.toneMappingExposure = 0.15;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.render(this.scene, this.cameraManager.activeCamera);
    // this.renderer.info.reset();
    // this.renderPass.mainCamera = this.cameraManager.activeCamera;
    // this.normalPass.texture.needsUpdate = true;
    // this.gaussGrainEffect.uniforms.time.value = timeManager.time;
    // this.effectComposer.render();
    // this.renderer.clearDepth();
    // this.renderer.render(this.postPostScene, this.cameraManager.activeCamera);
  }

  public updateSkyboxRotation() {
    this.scene.backgroundRotation = new Euler(
      MathUtils.degToRad(envValues.skyboxPolarAngle),
      MathUtils.degToRad(envValues.skyboxAzimuthalAngle),
      0,
    );
    this.scene.environmentRotation = new Euler(
      MathUtils.degToRad(envValues.skyboxPolarAngle),
      MathUtils.degToRad(envValues.skyboxAzimuthalAngle),
      0,
    );
  }

  private async loadHDRJPG(url: string): Promise<Texture> {
    return new Promise((resolve, reject) => {
      const pmremGenerator = new PMREMGenerator(this.renderer);
      const hdrJpg = new HDRJPGLoader(this.renderer).load(url, () => {
        const hdrJpgEquirectangularMap = hdrJpg.renderTarget.texture;
        hdrJpgEquirectangularMap.mapping = EquirectangularReflectionMapping;
        hdrJpgEquirectangularMap.needsUpdate = true;

        const envMap = pmremGenerator!.fromEquirectangular(hdrJpgEquirectangularMap).texture;
        hdrJpgEquirectangularMap.dispose();
        pmremGenerator!.dispose();
        hdrJpg.dispose();
        if (envMap) {
          envMap.colorSpace = LinearSRGBColorSpace;
          envMap.needsUpdate = true;
          resolve(envMap);
        } else {
          reject("Failed to generate environment map");
        }
      });
    });
  }

  private async loadHDRi(url: string): Promise<Texture> {
    return new Promise((resolve, reject) => {
      const pmremGenerator = new PMREMGenerator(this.renderer);
      new RGBELoader(new LoadingManager()).load(url, (texture) => {
        const envMap = pmremGenerator!.fromEquirectangular(texture).texture;
        texture.dispose();
        pmremGenerator!.dispose();
        if (envMap) {
          envMap.colorSpace = LinearSRGBColorSpace;
          envMap.needsUpdate = true;
          resolve(envMap);
        } else {
          reject("Failed to generate environment map");
        }
      });
    });
  }

  public useHDRJPG(url: string, fromFile: boolean = false): void {
    if (this.skyboxState.src.hdrJpgUrl === url) {
      return;
    }

    const hdrJPGPromise = this.loadHDRJPG(url);
    this.skyboxState.src = { hdrJpgUrl: url };
    this.skyboxState.latestPromise = hdrJPGPromise;
    hdrJPGPromise.then((envMap) => {
      if (this.skyboxState.latestPromise !== hdrJPGPromise) {
        return;
      }
      this.applyEnvMap(envMap);
    });
  }

  public useHDRI(url: string): void {
    if (this.skyboxState.src.hdrUrl === url) {
      return;
    }
    const hdrPromise = this.loadHDRi(url);
    this.skyboxState.src = { hdrUrl: url };
    this.skyboxState.latestPromise = hdrPromise;
    hdrPromise.then((envMap) => {
      if (this.skyboxState.latestPromise !== hdrPromise) {
        return;
      }
      this.applyEnvMap(envMap);
    });
  }

  public setHDRIFromFile(): void {
    if (!this.renderer) return;
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".hdr,.jpg";
    fileInput.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      if (!file) {
        console.log("no file");
        return;
      }
      const extension = file.name.split(".").pop();
      const fileURL = URL.createObjectURL(file);
      if (fileURL) {
        if (extension === "hdr") {
          this.useHDRI(fileURL);
        } else if (extension === "jpg") {
          this.useHDRJPG(fileURL);
        } else {
          console.error(`Unrecognized extension for HDR file ${file.name}`);
        }
        URL.revokeObjectURL(fileURL);
        document.body.removeChild(fileInput);
      }
    });
    document.body.appendChild(fileInput);
    fileInput.click();
  }

  public setFog(): void {
    if (envValues.fog.fogFar === 0) {
      this.scene.fog = null;
      return;
    }
    const fogColor = new Color().setRGB(
      envValues.fog.fogColor.r,
      envValues.fog.fogColor.g,
      envValues.fog.fogColor.b,
    );
    this.scene.fog = new Fog(fogColor, envValues.fog.fogNear, envValues.fog.fogFar);
  }

  public setAmbientLight(): void {
    if (this.ambientLight) {
      this.scene.remove(this.ambientLight);
      this.ambientLight.dispose();
    }
    const ambientLightColor = new Color().setRGB(
      envValues.ambientLight.ambientLightColor.r,
      envValues.ambientLight.ambientLightColor.g,
      envValues.ambientLight.ambientLightColor.b,
    );
    this.ambientLight = new AmbientLight(
      ambientLightColor,
      envValues.ambientLight.ambientLightIntensity,
    );
    this.scene.add(this.ambientLight);
  }

  private updateSunValues() {
    if (typeof this.environmentConfiguration?.sun?.intensity === "number") {
      sunValues.sunIntensity = this.environmentConfiguration.sun.intensity;
      this.sun?.setIntensity(this.environmentConfiguration.sun.intensity);
    }
    if (typeof this.environmentConfiguration?.sun?.azimuthalAngle === "number") {
      sunValues.sunPosition.sunAzimuthalAngle = this.environmentConfiguration.sun.azimuthalAngle;
      this.sun?.setAzimuthalAngle(
        this.environmentConfiguration.sun.azimuthalAngle * (Math.PI / 180),
      );
    }
    if (typeof this.environmentConfiguration?.sun?.polarAngle === "number") {
      sunValues.sunPosition.sunPolarAngle = this.environmentConfiguration.sun.polarAngle;
      this.sun?.setPolarAngle(this.environmentConfiguration.sun.polarAngle * (Math.PI / 180));
    }
    
    // Handle sun tracking configuration
    if (this.sun && this.environmentConfiguration?.sun?.tracking) {
      const trackingConfig = this.environmentConfiguration.sun.tracking;
      
      if (trackingConfig.enabled === false) {
        this.disableSunTracking();
      } else if (trackingConfig.enabled === true || 
                 typeof trackingConfig.speed === "number" || 
                 typeof trackingConfig.cycleDuration === "number") {
        const speed = trackingConfig.speed ?? this.sunTrackingSpeed;
        const cycleDuration = trackingConfig.cycleDuration ?? this.sunCycleDuration;
        this.enableSunTracking(speed, cycleDuration);
      }
    }
  }

  private updateFogValues() {
    if (typeof this.environmentConfiguration?.fog?.fogNear === "number") {
      envValues.fog.fogNear = this.environmentConfiguration.fog.fogNear;
    }
    if (typeof this.environmentConfiguration?.fog?.fogFar === "number") {
      envValues.fog.fogFar = this.environmentConfiguration.fog.fogFar;
    }
    if (
      typeof this.environmentConfiguration?.fog?.fogColor?.r === "number" &&
      typeof this.environmentConfiguration?.fog?.fogColor?.g === "number" &&
      typeof this.environmentConfiguration?.fog?.fogColor?.b === "number"
    ) {
      envValues.fog.fogColor.r = this.environmentConfiguration.fog.fogColor.r;
      envValues.fog.fogColor.g = this.environmentConfiguration.fog.fogColor.g;
      envValues.fog.fogColor.b = this.environmentConfiguration.fog.fogColor.b;
    }
    this.setFog();
  }

  private updateSkyboxAndEnvValues() {
    if (typeof this.environmentConfiguration?.envMap?.intensity === "number") {
      envValues.envMapIntensity = this.environmentConfiguration?.envMap.intensity;
    }
    this.scene.environmentIntensity = envValues.envMapIntensity;

    if (typeof this.environmentConfiguration?.skybox?.intensity === "number") {
      envValues.skyboxIntensity = this.environmentConfiguration?.skybox.intensity;
    }
    this.scene.backgroundIntensity = envValues.skyboxIntensity;

    if (typeof this.environmentConfiguration?.skybox?.blurriness === "number") {
      envValues.skyboxBlurriness = this.environmentConfiguration?.skybox.blurriness;
    }
    this.scene.backgroundBlurriness = envValues.skyboxBlurriness;

    if (typeof this.environmentConfiguration?.skybox?.azimuthalAngle === "number") {
      envValues.skyboxAzimuthalAngle = this.environmentConfiguration?.skybox.azimuthalAngle;
      this.updateSkyboxRotation();
    }

    if (typeof this.environmentConfiguration?.skybox?.polarAngle === "number") {
      envValues.skyboxPolarAngle = this.environmentConfiguration?.skybox.polarAngle;
      this.updateSkyboxRotation();
    }
  }

  private updateBloomValues() {
    if (typeof this.environmentConfiguration?.postProcessing?.bloomIntensity === "number") {
      extrasValues.bloom = this.environmentConfiguration.postProcessing.bloomIntensity;
    }
    this.bloomEffect.intensity = extrasValues.bloom;
  }

  private updateAmbientLightValues() {
    if (typeof this.environmentConfiguration?.ambientLight?.intensity === "number") {
      envValues.ambientLight.ambientLightIntensity =
        this.environmentConfiguration.ambientLight.intensity;
    }
    this.setAmbientLight();
  }

  private applyEnvMap(envMap: Texture) {
    this.scene.environment = envMap;
    this.scene.environmentIntensity = envValues.envMapIntensity;
    this.scene.environmentRotation = new Euler(
      MathUtils.degToRad(envValues.skyboxPolarAngle),
      MathUtils.degToRad(envValues.skyboxAzimuthalAngle),
      0,
    );
    this.scene.background = envMap;
    this.scene.backgroundIntensity = envValues.skyboxIntensity;
    this.scene.backgroundBlurriness = envValues.skyboxBlurriness;
    this.scene.backgroundRotation = new Euler(
      MathUtils.degToRad(envValues.skyboxPolarAngle),
      MathUtils.degToRad(envValues.skyboxAzimuthalAngle),
      0,
    );
  }

  private initializeAtmosphericSky() {
    if (this.sky) {
      this.scene.remove(this.sky);
    }
    
    this.sky = new Sky();
    this.sky.scale.setScalar(10000);
    this.scene.add(this.sky);
    
    // Set default sky parameters
    const skyUniforms = (this.sky.material as any).uniforms;
    skyUniforms.turbidity.value = 3.5;
    skyUniforms.rayleigh.value = 2.5;
    skyUniforms.mieCoefficient.value = 0.008;
    skyUniforms.mieDirectionalG.value = 0.85;
    
    this.updateAtmosphericSky();
  }

  private updateAtmosphericSky() {
    if (!this.sky || !this.skyEnvironmentGenerator) return;
    
    const skyUniforms = (this.sky.material as any).uniforms;
    
    // Update sky parameters from tweakpane values
    skyUniforms.turbidity.value = envValues.atmosphericSky.turbidity;
    skyUniforms.rayleigh.value = envValues.atmosphericSky.rayleigh;
    skyUniforms.mieCoefficient.value = envValues.atmosphericSky.mieCoefficient;
    skyUniforms.mieDirectionalG.value = envValues.atmosphericSky.mieDirectionalG;
    
    // Update sky parameters from environment configuration if available
    if (this.environmentConfiguration?.skybox && "atmospheric" in this.environmentConfiguration.skybox) {
      const atmospheric = this.environmentConfiguration.skybox.atmospheric;
      if (atmospheric) {
        if (typeof atmospheric.turbidity === "number") {
          skyUniforms.turbidity.value = atmospheric.turbidity;
          envValues.atmosphericSky.turbidity = atmospheric.turbidity;
        }
        if (typeof atmospheric.rayleigh === "number") {
          skyUniforms.rayleigh.value = atmospheric.rayleigh;
          envValues.atmosphericSky.rayleigh = atmospheric.rayleigh;
        }
        if (typeof atmospheric.mieCoefficient === "number") {
          skyUniforms.mieCoefficient.value = atmospheric.mieCoefficient;
          envValues.atmosphericSky.mieCoefficient = atmospheric.mieCoefficient;
        }
        if (typeof atmospheric.mieDirectionalG === "number") {
          skyUniforms.mieDirectionalG.value = atmospheric.mieDirectionalG;
          envValues.atmosphericSky.mieDirectionalG = atmospheric.mieDirectionalG;
        }
        if (atmospheric.sunPosition) {
          skyUniforms.sunPosition.value.copy(atmospheric.sunPosition);
        }
      }
    }
    
    // Sync sun position with sky if sun exists
    if (this.sun) {
      // Use the EXACT same coordinate calculation as the Sun class
      // The Sun class uses polarAngle as elevation angle (-90° to +90°)
      const azimuthalRad = sunValues.sunPosition.sunAzimuthalAngle * (Math.PI / 180);
      const polarRad = sunValues.sunPosition.sunPolarAngle * (Math.PI / 180);
      
      // Create sun position vector using the EXACT same calculation as Sun class
      // This matches setSunPosition() in Sun.ts exactly
      const sunPosition = new Vector3(
        Math.sin(polarRad) * Math.cos(azimuthalRad),
        Math.cos(polarRad),
        Math.sin(polarRad) * Math.sin(azimuthalRad)
      );
      
      skyUniforms.sunPosition.value.copy(sunPosition);
    }
    
    // Generate environment map from sky
    const envMapRenderTarget = this.skyEnvironmentGenerator.generateEnvironmentMap(
      this.sky, 
      this.scene, 
      this.cameraManager.activeCamera.position
    );
    const envMap = envMapRenderTarget.texture;
    
    // Apply the generated environment map
    this.scene.environment = envMap;
    this.scene.environmentIntensity = envValues.envMapIntensity;
    this.scene.environmentRotation = new Euler(
      MathUtils.degToRad(envValues.skyboxPolarAngle),
      MathUtils.degToRad(envValues.skyboxAzimuthalAngle),
      0,
    );
    
    // The sky mesh itself serves as the background
    this.scene.background = null; // Clear any existing background texture
    this.scene.backgroundIntensity = envValues.skyboxIntensity;
    this.scene.backgroundBlurriness = envValues.skyboxBlurriness;
    this.scene.backgroundRotation = new Euler(
      MathUtils.degToRad(envValues.skyboxPolarAngle),
      MathUtils.degToRad(envValues.skyboxAzimuthalAngle),
      0,
    );
  }

  public syncSunWithSky() {
    if (!this.sky || !this.sun) return;
    
    const skyUniforms = (this.sky.material as any).uniforms;
    
    // Use the EXACT same coordinate calculation as Sun class
    const azimuthalRad = sunValues.sunPosition.sunAzimuthalAngle * (Math.PI / 180);
    const polarRad = sunValues.sunPosition.sunPolarAngle * (Math.PI / 180);
    
    // Create sun position vector using the EXACT same calculation as Sun class
    const sunPosition = new Vector3(
      Math.sin(polarRad) * Math.cos(azimuthalRad),
      Math.cos(polarRad),
      Math.sin(polarRad) * Math.sin(azimuthalRad)
    );
    
    skyUniforms.sunPosition.value.copy(sunPosition);
    
    // Regenerate environment map when sun position changes
    this.updateAtmosphericSky();
  }

  /**
   * Enable sun tracking across the sky
   * @param speed Speed multiplier for sun movement (default: 1.0)
   * @param cycleDuration Duration of full sun cycle in seconds (default: 10)
   */
  public enableSunTracking(speed: number = 1.0, cycleDuration: number = 10): void {
    if (!this.sun) {
      console.warn("Cannot enable sun tracking: no sun instance available");
      return;
    }
    this.sunTrackingEnabled = true;
   this.sunTrackingSpeed = speed;
    this.sunCycleDuration = cycleDuration;
    this.sunStartTime = 0; // Will be set on first update
  }

  /**
   * Disable sun tracking
   */
  public disableSunTracking(): void {
    this.sunTrackingEnabled = false;
  }

  /**
   * Update sun position based on time for tracking across the sky
   * @param currentTime Current time from TimeManager
   */
  private updateSunTracking(currentTime: number): void {
    if (!this.sun) return;

    // Initialize start time on first call
    if (this.sunStartTime === 0) {
      this.sunStartTime = 50;
    }

    // Calculate elapsed time since tracking started
    const elapsedTime = (currentTime - this.sunStartTime) * 0.2;
    
    // Calculate progress through the cycle (0 to 1)
    const cycleProgress = (elapsedTime % this.sunCycleDuration) / this.sunCycleDuration;
    
    // Sun moves in a complete 360° circle over the cycle
    // Start from east (90°), go through south (180°), west (270°), north (0°/360°), back to east
    const azimuthalAngle = 90 + (cycleProgress * 360); // 90° to 450° (wraps to 90°)
    
    // Polar angle in Sun coordinate system: 0° = zenith, 90° = horizon, >90° = below horizon
    // Create a sine wave where sun is visible for half the cycle and hidden for the other half
    const minPolarAngle = 50; // High in sky (midday)
    const maxPolarAngle = 110; // Below horizon (night)
    const polarAngleRange = maxPolarAngle - minPolarAngle; // 80° range
    const polarAngleCenter = (minPolarAngle + maxPolarAngle) / 2; // 70° center
    
    // Sine wave: sun is high during first half of cycle (day), low during second half (night)
    // When progress = 0.25 (morning): sun rises
    // When progress = 0.5 (midday): sun peaks
    // When progress = 0.75 (evening): sun sets
    // When progress = 0 or 1 (midnight): sun is below horizon
    const polarAngle = polarAngleCenter - (Math.cos(cycleProgress * 2 * Math.PI) * (polarAngleRange / 2));
    
    // Calculate dynamic sun intensity based on sun elevation
    // Get the base intensity from configuration or default
    const baseSunIntensity = this.environmentConfiguration?.sun?.intensity ?? sunValues.sunIntensity;
    let sunIntensity = 0;
    
    // Define horizon and fade zones
    const horizonAngle = 90; // 90° = horizon
    const fadeStartAngle = 75; // Start fading intensity at 75° (15° above horizon)
    const fadeEndAngle = 95; // Complete fade by 95° (5° below horizon)
    
    if (polarAngle <= fadeStartAngle) {
      // Sun is high in sky - full intensity
      sunIntensity = baseSunIntensity;
    } else if (polarAngle >= fadeEndAngle) {
      // Sun is below horizon - zero intensity
      sunIntensity = 0;
    } else {
      // Sun is in the fade zone - interpolate intensity
      const fadeProgress = (polarAngle - fadeStartAngle) / (fadeEndAngle - fadeStartAngle);
      // Use smooth fade curve (cosine interpolation for natural sunset effect)
      const fadeFactor = (Math.cos(fadeProgress * Math.PI) + 1) / 2;
      sunIntensity = baseSunIntensity * fadeFactor;
    }
    
    // Update sun values and position
    sunValues.sunPosition.sunAzimuthalAngle = azimuthalAngle % 360; // Keep within 0-360 range
    sunValues.sunPosition.sunPolarAngle = polarAngle;
    
    // Apply the new angles and intensity to the sun
    this.sun.setAzimuthalAngle((azimuthalAngle % 360) * (Math.PI / 180));
    this.sun.setPolarAngle(polarAngle * (Math.PI / 180));
    this.sun.setIntensity(sunIntensity);
    
    // Update atmospheric sky if present
    this.syncSunWithSky();
  }
}
