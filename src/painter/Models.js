import { useGLTF } from "@react-three/drei";
import { useEffect } from "react";
import { computeScreenAnchor, findScreenGlassMesh } from "./CSS3DScreen";

const COMPUTER_MODEL_URL = `${process.env.PUBLIC_URL}/models/computer/screen.gltf`;

export function Computer({ onScreenAnchor, hideScreen, ...props }) {
  const { scene } = useGLTF(COMPUTER_MODEL_URL);

  useEffect(() => {
    scene.traverse((child) => {
      if (child.isMesh) {
        if (child.name === "Cube") {
          child.visible = false;
          return;
        }

        child.castShadow = true;
        child.receiveShadow = true;
      }
    });

    if (onScreenAnchor) {
      const glassMesh = findScreenGlassMesh(scene);
      if (glassMesh) {
        onScreenAnchor(computeScreenAnchor(glassMesh));
      }
    }
  }, [scene, onScreenAnchor]);

  useEffect(() => {
    const glassMesh = findScreenGlassMesh(scene);
    if (glassMesh) {
      glassMesh.visible = !hideScreen;
    }
  }, [scene, hideScreen]);

  return <primitive object={scene} {...props} />;
}

useGLTF.preload(COMPUTER_MODEL_URL);
