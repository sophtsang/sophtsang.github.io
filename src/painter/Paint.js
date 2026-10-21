import RevealOverlay from "./RevealOverlay";
import * as THREE from "three";
import {
  OrbitControls,
  OrthographicCamera,
  useFBO,
  useTexture,
  Effects,
} from "@react-three/drei";
import { Canvas, useFrame, useThree, extend } from "@react-three/fiber";
import { useControls, folder, Leva } from "leva";
import { Suspense, useRef, useCallback, useEffect } from "react";
import { Computer } from "./Models";
import { MiniKuwaharaPass, TensorPass, KuwaharaPass, FinalPass } from "./PostProcessing";
import { CSS3DScreenController } from "./CSS3DScreen";

extend({ MiniKuwaharaPass, TensorPass, KuwaharaPass, FinalPass });

// The 2D site is a separately hosted/deployed site (the kernel_bsod repo), not
// part of this app — this is the only thing that connects the two.
const DESKTOP_URL = "https://sophtsang.github.io/kernel_bsod";

// Reused across frames (avoids allocating in the render loop) for the
// hover-focus camera snap below.
const _anchorPos = new THREE.Vector3();
const _anchorQuat = new THREE.Quaternion();
const _normalWorld = new THREE.Vector3();
const _upWorld = new THREE.Vector3();
const _candidateA = new THREE.Vector3();
const _candidateB = new THREE.Vector3();
const _targetPos = new THREE.Vector3();
const _targetQuat = new THREE.Quaternion();
const _currentForward = new THREE.Vector3();
const _currentUp = new THREE.Vector3();
// throwaway Object3D used only to borrow Object3D.lookAt's matrix math
// (which respects a custom `up`) to derive _targetQuat
const _dummy = new THREE.Object3D();
_dummy.isCamera = true;

function getModel(model, onScreenAnchor, hideScreen) {
  if (model === "computer") {
    return <Computer onScreenAnchor={onScreenAnchor} hideScreen={hideScreen} />
  }
}

const Painting = ({ cssContainerRef, orbitControlsRef }) => {
  const materialRef = useRef();
  const miniKuwaharaPassRef = useRef();
  const tensorPassRef = useRef();
  const kuwaharaPassRef = useRef();
  const finalPassRef = useRef();
  const cssControllerRef = useRef(null);
  const screenAnchorRef = useRef(null);
  const focusProgressRef = useRef(0);
  // Was the camera mid-focus last frame? Used to detect the
  // focus-start/focus-end transitions below.
  const wasFocusedRef = useRef(false);
  // The camera's OrbitControls-driven pose at the instant the screen was
  // clicked, i.e. what we lerp from and snap back to on unfocus.
  const savedPoseRef = useRef({
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    zoom: 1,
  });
  const { size } = useThree();

  const { miniKuwaharaPass, tensorPass, finalPass, radius, model } = useControls({
    passes: folder({
      miniKuwaharaPass: { value: false },
      tensorPass: { value: false },
      finalPass: { value: false },
    }),
    radius: { value: 9, min: 1, max: 15, step: 1 },
    model: {
        value: "computer",
    }
  });

  const {
    cssScreen,
    cssOffsetX, cssOffsetY, cssOffsetZ,
    cssRotX, cssRotY, cssRotZ,
    cssFlipX, cssFlipY,
  } = useControls({
    screenOverlay: folder({
      cssScreen: { value: true, label: "enabled" },
      cssOffsetX: { value: 0, min: -0.2, max: 0.2, step: 0.001 },
      cssOffsetY: { value: 0, min: -0.2, max: 0.2, step: 0.001 },
      cssOffsetZ: { value: 0, min: -0.2, max: 0.2, step: 0.001 },
      cssRotX: { value: 0, min: -180, max: 180, step: 1 },
      cssRotY: { value: 0, min: -180, max: 180, step: 1 },
      cssRotZ: { value: 0, min: -180, max: 180, step: 1 },
      cssFlipX: { value: false },
      cssFlipY: { value: false },
    }),
  });

  const { clickFocus, focusDistance, focusZoom, focusLerpSpeed } = useControls({
    focus: folder({
      clickFocus: { value: true, label: "focus on click" },
      focusDistance: { value: 2, min: 0.1, max: 10, step: 0.1 },
      focusZoom: { value: 1200, min: 500, max: 1350, step: 10 },
      focusLerpSpeed: { value: 1, min: 1, max: 3, step: 0.5 },
    }),
  });

  const handleScreenAnchor = useCallback((anchor) => {
    screenAnchorRef.current = anchor;
  }, []);

  useEffect(() => {
    if (!cssControllerRef.current) {
      cssControllerRef.current = new CSS3DScreenController({ src: DESKTOP_URL });
    }
    const controller = cssControllerRef.current;
    const container = cssContainerRef.current;
    if (container) controller.mount(container);
    return () => {
      if (container) controller.unmount(container);
    };
  }, [cssContainerRef]);

  useEffect(() => {
    cssControllerRef.current?.setSize(size.width, size.height);
  }, [size]);

  const paintNormalTexture = useTexture(
    "https://cdn.maximeheckel.com/textures/paint-normal.jpg"
  );
  paintNormalTexture.minFilter = THREE.LinearMipmapLinearFilter;
  paintNormalTexture.magFilter = THREE.LinearFilter;
  paintNormalTexture.generateMipmaps = true;

  const watercolorTexture = useTexture(
    "https://cdn.maximeheckel.com/textures/paper/watercolor.png"
  );
  watercolorTexture.minFilter = THREE.LinearMipmapLinearFilter;
  watercolorTexture.magFilter = THREE.LinearFilter;
  watercolorTexture.generateMipmaps = true;

  const originalSceneTarget = useFBO(
    window.innerWidth * Math.min(window.devicePixelRatio, 2),
    window.innerHeight * Math.min(window.devicePixelRatio, 2)
  );

  useFrame((state, delta) => {
    const { gl, scene, camera } = state;

    if (materialRef.current) {
      materialRef.current.uniforms.uPaintNormalMap.value = paintNormalTexture;
    }

    // Render once to the FBO with all passes disabled (the "clean" pass
    // KuwaharaPass reads back as its originalSceneTarget)...
    miniKuwaharaPassRef.current.enabled = false;
    tensorPassRef.current.enabled = false;
    kuwaharaPassRef.current.enabled = false;
    finalPassRef.current.enabled = false;
    gl.setRenderTarget(originalSceneTarget);
    gl.render(scene, camera);

    // // ...then render again to the screen with the actual pass toggles applied.
    miniKuwaharaPassRef.current.enabled = miniKuwaharaPass;
    tensorPassRef.current.enabled = tensorPass;
    // this shader is actually terrible for performance, so when interacting with 2d screen
    // disable it
    kuwaharaPassRef.current.enabled = camera.zoom < 700;
    finalPassRef.current.enabled = finalPass;
    gl.setRenderTarget(null);
    // gl.render(scene, camera);

    const screenAnchor = screenAnchorRef.current;
    const controls = orbitControlsRef.current;
    const cssController = cssControllerRef.current;

    // Snap the camera to sit on the screen's own normal axis — parallel to
    // the glass and zoomed in, but like also don't be able to click through the back
    const FRONT_AXIS = new THREE.Vector3(0, 0, 1);
    const angle = THREE.MathUtils.radToDeg(camera.position.angleTo(FRONT_AXIS))
    const isFront = angle > 5 && angle < 90;
    const focused = clickFocus && !!screenAnchor && !!cssController?.isClicked() && isFront;

    if (focused !== wasFocusedRef.current) {
      if (focused) {
        // Entering focus: freeze OrbitControls and remember the pose it was
        // left at, which is our lerp start.
        savedPoseRef.current.position.copy(camera.position);
        savedPoseRef.current.quaternion.copy(camera.quaternion);
        savedPoseRef.current.zoom = camera.zoom;
        focusProgressRef.current = 0;
        if (controls) controls.enabled = false;
      } else if (controls) {
        // unfocus when out of screen -> re-derive OrbitControls' orbit target 
        _currentForward.set(0, 0, -1).applyQuaternion(camera.quaternion);
        _currentUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
        const pivotDistance = screenAnchor ? camera.position.distanceTo(_anchorPos) : 1;
        controls.target.copy(camera.position).addScaledVector(_currentForward, pivotDistance || 1);
        camera.up.copy(_currentUp);
        controls.enabled = true;
      }
      wasFocusedRef.current = focused;
    }

    if (focused) {
      focusProgressRef.current = THREE.MathUtils.damp(focusProgressRef.current, 1, focusLerpSpeed, delta);

      screenAnchor.getWorldPosition(_anchorPos);
      screenAnchor.getWorldQuaternion(_anchorQuat);
      // Anchor-local +Z is the glass's normal axis, +Y its "up" (see the
      // axis comment in CSS3DScreen.js's computeScreenAnchor).
      _normalWorld.set(0, 0, 1).applyQuaternion(_anchorQuat).normalize();
      _upWorld.set(0, 1, 0).applyQuaternion(_anchorQuat).normalize();

      // The normal's sign (into vs. out of the screen) isn't guaranteed, so
      // pick whichever side the camera was already on at focus-start.
      _candidateA.copy(_anchorPos).addScaledVector(_normalWorld, focusDistance);
      _candidateB.copy(_anchorPos).addScaledVector(_normalWorld, -focusDistance);
      _targetPos.copy(
        _candidateA.distanceToSquared(savedPoseRef.current.position) <=
          _candidateB.distanceToSquared(savedPoseRef.current.position)
          ? _candidateA
          : _candidateB
      );

      _dummy.position.copy(_targetPos);
      _dummy.up.copy(_upWorld);
      _dummy.lookAt(_anchorPos);
      _targetQuat.copy(_dummy.quaternion);

      camera.position.lerpVectors(savedPoseRef.current.position, _targetPos, focusProgressRef.current);
      camera.quaternion.copy(savedPoseRef.current.quaternion).slerp(_targetQuat, focusProgressRef.current);
      camera.zoom = THREE.MathUtils.lerp(savedPoseRef.current.zoom, focusZoom, focusProgressRef.current);
      camera.updateProjectionMatrix();
    }

    if (cssController && model === "computer" && screenAnchor) {
      cssController.setVisible(cssScreen);
      if (cssScreen) {
        cssController.syncToAnchor(screenAnchor, {
          offset: { x: cssOffsetX, y: cssOffsetY, z: cssOffsetZ },
          rotationOffset: {
            x: (cssRotX * Math.PI) / 180,
            y: (cssRotY * Math.PI) / 180,
            z: (cssRotZ * Math.PI) / 180,
          },
          flipX: cssFlipX,
          flipY: cssFlipY,
        });
        cssController.render(camera);
      }
    } else if (cssController) {
      cssController.setVisible(false);
    }
  });

  return (
    <>
      <group
        scale={1.0}
        rotation={[0, -95*Math.PI/180, 7*Math.PI/180]}
      >
        {getModel(model, handleScreenAnchor, cssScreen)}
      </group>

      <Effects>
        <miniKuwaharaPass
          ref={miniKuwaharaPassRef}
          args={[{radius, originalSceneTarget: originalSceneTarget}]}/>
        <tensorPass ref={tensorPassRef} />
        <kuwaharaPass
          ref={kuwaharaPassRef}
          args={[{radius, originalSceneTarget: originalSceneTarget}]}
        />
        <finalPass
          ref={finalPassRef}
          args={[{watercolorTexture: watercolorTexture},]}
        />
      </Effects>
    </>
  );
};

const Paint = () => {
  const overlayRef = useRef(null);

  // Tracked on the wrapping div rather than the Canvas's synthetic events,
  // so coordinates line up with the overlay's own canvas.getBoundingClientRect().
  const downPosRef = useRef(null);
  const downTimeRef = useRef(null);
  const containerRef = useRef(null);
  const cssContainerRef = useRef(null);
  const orbitControlsRef = useRef(null);

  const handlePointerDown = useCallback((event) => {
    downPosRef.current = { x: event.clientX, y: event.clientY };
    downTimeRef.current = performance.now();
  }, []);

  const handlePointerUp = useCallback((event) => {
    const downPos = downPosRef.current;
    if (!downPos) return;

    const dx = event.clientX - downPos.x;
    const dy = event.clientY - downPos.y;
    const holdDuration = (performance.now() - downTimeRef.current) / 1000;

    downPosRef.current = null;
    downTimeRef.current = null;

    // Same drag-vs-click threshold RevealOverlay used to apply itself —
    // lets OrbitControls' drags pass through without also painting.
    if (Math.sqrt(dx * dx + dy * dy) > 4) return;

    const rect = containerRef.current.getBoundingClientRect();
    const u = (event.clientX - rect.left) / rect.width;
    const v = 1.0 - (event.clientY - rect.top) / rect.height; // flip Y to match shader UV convention

    overlayRef.current?.spawnSplatter(u, v, holdDuration);
  }, []);

  return (
    <div
      ref={containerRef}
      style={{ position: "relative", width: "100vw", height: "100vh" }}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
    >
      {/* Keeps the useControls calls in Painting working (they still drive
          radius/focus/etc. from their default values) while hiding the
          auto-mounted debug panel itself. */}
      <Leva hidden />
      <Canvas dpr={[1, 2]} style={{ position: "absolute", inset: 0, zIndex: 0 }}>
        <Suspense fallback="Loading">
          <ambientLight intensity={1.0} />
          <directionalLight position={[-5, 5, 5]} intensity={4} />
          <color attach="background" args={["#55737a"]} />
          <Painting cssContainerRef={cssContainerRef} orbitControlsRef={orbitControlsRef} />
          <OrbitControls 
            ref={orbitControlsRef} 
            minZoom={200} maxZoom={1500} 
          />
          <OrthographicCamera
            makeDefault
            position={[0, 0, 10]}
            zoom={300}
            near={0.01}
            far={1000}
          />
        </Suspense>
      </Canvas>

      {/* Houses the CSS3DRenderer's DOM output (the "Screen" mesh's iframe
          overlay, pointed at the separately-hosted kernel_bsod site). It sits
          above the Canvas so the iframe is visible without punching a
          transparency hole through the WebGL/postprocessing pipeline; only
          the iframe itself takes pointer events (set in
          CSS3DScreenController) so drags elsewhere still reach
          OrbitControls. */}
      <div
        ref={cssContainerRef}
        style={{ position: "absolute", inset: 0, zIndex: 1, overflow: "hidden", pointerEvents: "none" }}
      />

      {/* Click-through overlay: paints on top, but pointer events fall through
          to the Canvas above (and OrbitControls attached to it) */}
      {/* <div
        style={{ position: "absolute", inset: 0, zIndex: 10, pointerEvents: "none" }}
      >
        <RevealOverlay ref={overlayRef} />
      </div> */}
    </div>
  );
};

export default Paint;
