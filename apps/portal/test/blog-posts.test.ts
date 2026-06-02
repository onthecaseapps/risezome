import { describe, expect, it } from 'vitest';
import { POSTS, getAllPosts, getPost, tableOfContents } from '../app/(marketing)/blog/_posts';

describe('blog post data', () => {
  it('has at least the two launch posts', () => {
    expect(POSTS.length).toBeGreaterThanOrEqual(2);
  });

  it('has unique slugs', () => {
    const slugs = POSTS.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('every post has unique heading ids (so TOC anchors resolve)', () => {
    for (const post of POSTS) {
      const ids = tableOfContents(post).map((h) => h.id);
      expect(new Set(ids).size, `duplicate heading id in ${post.slug}`).toBe(ids.length);
    }
  });

  it('every post carries the required listing + meta fields', () => {
    for (const post of POSTS) {
      expect(post.title.length, post.slug).toBeGreaterThan(0);
      expect(post.excerpt.length, post.slug).toBeGreaterThan(0);
      expect(post.kicker.length, post.slug).toBeGreaterThan(0);
      expect(post.date, post.slug).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(post.readingMinutes, post.slug).toBeGreaterThan(0);
      expect(post.body.length, post.slug).toBeGreaterThan(0);
    }
  });

  it('getAllPosts returns newest first', () => {
    const dates = getAllPosts().map((p) => p.date);
    const sorted = [...dates].sort((a, b) => (a < b ? 1 : -1));
    expect(dates).toEqual(sorted);
  });

  it('getPost resolves a known slug and rejects an unknown one', () => {
    expect(getPost(POSTS[0]!.slug)?.slug).toBe(POSTS[0]!.slug);
    expect(getPost('does-not-exist')).toBeUndefined();
  });
});
