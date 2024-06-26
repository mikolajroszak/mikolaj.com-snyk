import * as registryClient from '@snyk/docker-registry-v2-client';
import { promises as fs } from 'fs';
import * as path from 'path';
import {
  IaCErrorCodes,
  ImageManifest,
  ManifestConfig,
  OCIPullOptions,
  OciUrl,
} from './types';
import { CustomError } from '../../../../lib/errors';
import { getErrorStringCode } from './error-utils';
import { LOCAL_POLICY_ENGINE_DIR } from './local-cache';
import * as Debug from 'debug';
import { initLocalCache } from './measurable-methods';
import { createIacDir } from './file-utils';
const debug = Debug('iac-oci-pull');

export function extractURLComponents(OCIRegistryURL: string): OciUrl {
  try {
    const url = OCIRegistryURL.split('://')[1];
    const [registryBase, accountName, repoWithTag] = url.split('/');
    const [repoName, tag] = repoWithTag.split(':');
    const repo = accountName + '/' + repoName;
    return { registryBase, repo, tag };
  } catch {
    throw new InvalidRemoteRegistryURLError();
  }
}

/**
 * Downloads an OCI Artifact from a remote OCI Registry and writes it to the disk.
 * The artifact here is a custom rules bundle stored in a remote registry.
 * In order to do that, it calls an external docker registry v2 client to get the manifests, the layers and then builds the artifact.
 * Example: https://github.com/opencontainers/image-spec/blob/main/manifest.md#example-image-manifest
 * @param OCIRegistryURL - the URL where the custom rules bundle is stored
 * @param opt????? (optional) - object that holds the credentials and other metadata required for the registry-v2-client
 **/
export async function pull(
  OCIRegistryURL: string,
  opt?: OCIPullOptions,
): Promise<void> {
  if (!isValidURL(OCIRegistryURL)) {
    throw new InvalidRemoteRegistryURLError();
  }
  const { registryBase, repo, tag } = extractURLComponents(OCIRegistryURL);
  const manifest: ImageManifest = await registryClient.getManifest(
    registryBase,
    repo,
    tag,
    opt?.username,
    opt?.password,
    opt?.reqOptions,
  );

  if (manifest.schemaVersion !== 2) {
    throw new InvalidManifestSchemaVersionError(
      manifest.schemaVersion.toString(),
    );
  }
  const manifestLayers: ManifestConfig[] = manifest.layers;
  // We assume that we will always have an artifact of a single layer
  if (manifestLayers.length > 1) {
    debug('There were more than one layers found in the OCI Artifact.');
  }

  const blob = await registryClient.getLayer(
    registryBase,
    repo,
    manifestLayers[0].digest,
    opt?.username,
    opt?.password,
    opt?.reqOptions,
  );

  try {
    const downloadPath: string = path.join(
      LOCAL_POLICY_ENGINE_DIR,
      'custom-bundle.tar.gz',
    );
    createIacDir();
    await fs.writeFile(downloadPath, blob);
    await initLocalCache({ customRulesPath: downloadPath });
  } catch (err) {
    throw new FailedToBuildOCIArtifactError();
  }
}

function isValidURL(string) {
  let url;
  try {
    url = new URL(string);
  } catch (e) {
    return false;
  }
  return url.protocol === 'http:' || url.protocol === 'https:';
}

export class FailedToBuildOCIArtifactError extends CustomError {
  constructor(message?: string) {
    super(message || 'Could not build OCI Artifact');
    this.code = IaCErrorCodes.FailedToBuildOCIArtifactError;
    this.strCode = getErrorStringCode(this.code);
    this.userMessage =
      'We were unable to build the remote OCI Artifact locally, please ensure that the local directory is writeable.';
  }
}

export class InvalidRemoteRegistryURLError extends CustomError {
  constructor(message?: string) {
    super(message || 'Invalid URL for Remote Registry');
    this.code = IaCErrorCodes.InvalidRemoteRegistryURLError;
    this.strCode = getErrorStringCode(this.code);
    this.userMessage =
      'The Remote Registry URL is invalid, or does not include a http/https protocol. Please check it again.';
  }
}

export class InvalidManifestSchemaVersionError extends CustomError {
  constructor(message?: string) {
    super(message || 'Invalid manifest schema version');
    this.code = IaCErrorCodes.InvalidRemoteRegistryURLError;
    this.strCode = getErrorStringCode(this.code);
    this.userMessage = `Invalid manifest schema version: ${message}. We currently support Image Manifest Version 2, Schema 2`;
  }
}
