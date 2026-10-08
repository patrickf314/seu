// Paths inside the guest, shared by the host-side code and the commands.

const HOME_DIR = '/home/seu';

export const VOLUME_MOUNT = HOME_DIR;

/**
 * The worktree, mounted read-only. Nothing in here is ever written to.
 */
export const SRC_MOUNT = '/src';

/** The writable clone of /src, living in the named volume. */
export const WORK_DIR = HOME_DIR + '/work';

/**
 * The host's own Maven repository, read-only. Install sandbox only.
 */
export const HOST_REPOSITORY_MOUNT = '/host-m2';
