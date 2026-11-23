import { useEffect, useState } from "react";
import { packageFileBlob, type PackageFileSource } from "./nativeFiles.ts";

export const isBackgroundName = (name: string) => /\.(png|jpe?g)$/i.test(name);

async function decodeImage(source: PackageFileSource) {
  const blob = await packageFileBlob(source);
  const header = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
  const png =
    /\.png$/i.test(source.name) &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => header[i] === b);
  const jpeg =
    /\.jpe?g$/i.test(source.name) &&
    header[0] === 255 &&
    header[1] === 216 &&
    header[2] === 255;
  const error = "“" + source.name + "” is not a readable PNG or JPEG image.";
  if (!png && !jpeg) throw Error(error);
  const raster = blob.slice(0, blob.size, png ? "image/png" : "image/jpeg");
  try {
    const image = await createImageBitmap(raster);
    image.close();
  } catch {
    throw Error(error);
  }
  return raster;
}

// Share validation with the canvas and retain only the most recent image.
let recent: { id: string; result: Promise<Blob> } | undefined;
export function backgroundImage(source: PackageFileSource) {
  const id = JSON.stringify([source.packaged, source.key, source.name]);
  if (recent?.id !== id) {
    const result = decodeImage(source).catch((error) => {
      if (recent?.result === result) recent = undefined;
      throw error;
    });
    recent = { id, result };
  }
  return recent.result;
}

export function LogicalBackground({
  source,
  tiled,
  onError,
}: {
  source: PackageFileSource;
  tiled: boolean;
  onError: (message: string) => void;
}) {
  const { key, name, packaged } = source;
  const [url, setUrl] = useState("");
  useEffect(() => {
    let active = true;
    let objectUrl = "";
    backgroundImage({ key, name, packaged })
      .then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch((error) => {
        if (active)
          onError(
            error instanceof Error
              ? error.message
              : "Could not display the package background.",
          );
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [key, name, packaged, onError]);
  return url ? (
    <div
      role="img"
      aria-label={"Logical background " + name}
      className="ns-package-background"
      style={{
        backgroundImage: `url("${url}")`,
        backgroundRepeat: tiled ? "repeat" : "no-repeat",
      }}
    />
  ) : null;
}
