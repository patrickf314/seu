import { die } from '../common/error.ts';
import { sdk } from './sdk.ts';

/**
 * Checks if the given image reference exists, fails otherwise
 */
export async function requireImage(reference: string): Promise<void> {
    const { Image } = await sdk();
    const images = await Image.list();
    const imageLoaded = images.some((i) => i.reference === reference);

    if (!imageLoaded) {
        die(`image ${reference} is not in microsandbox's image store -- \`msb image ls\` shows what is`);
    }
}
