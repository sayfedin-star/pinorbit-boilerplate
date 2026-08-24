import { describe, it, expect } from 'vitest';
import { extractPinData } from '../../../scripts/pinarchive-refresh.mjs';

describe('PinArchive Relay Block Extraction Unit Tests', () => {
  const pinId = '11822017768540414';

  const relayHtmlFixture = `
<!DOCTYPE html>
<html>
<head><title>Pinterest</title></head>
<body>
<script type="text/javascript">
window.__PWS_RELAY_REGISTER_COMPLETED_REQUEST__("/resource/PinResource/get/", {
  "data": {
    "v3GetPinQueryv2": {
      "data": {
        "entityId": "11822017768540414",
        "id": "UGluOjExODIyMDE3NzY4NTQwNDE0",
        "aggregatedStats": {
          "saves": 265
        },
        "repinCount": 223,
        "commentCount": 14,
        "shareCount": 8,
        "title": "Healthy Keto Bread Recipe",
        "description": "Easy to make low carb bread.",
        "link": "https://example.com/recipe",
        "domain": "example.com",
        "dominantColor": "#5a4332",
        "imageSignature": "sig123456",
        "createdAt": "2024-01-15T12:00:00Z",
        "seoAltText": "Delicious gluten free keto bread",
        "board": {
          "entityId": "999888777",
          "name": "Keto Recipes",
          "pinCount": 120,
          "boardOrderModifiedAt": "2024-02-01T00:00:00Z"
        },
        "pinner": {
          "username": "cindymay3977",
          "followerCount": 4500
        },
        "pinJoin": {
          "seoBreadcrumbs": [
            { "name": "Food And Drinks" }
          ],
          "canonicalPin": {
            "entityId": "11822017768540414"
          },
          "visualAnnotation": [
            "Keto Bread",
            "Low Carb",
            "Baking"
          ],
          "annotationsWithLinksArray": [
            { "name": "Bread Recipe", "url": "/ideas/bread-recipe/1001/" },
            { "name": "Keto Baking", "url": "/ideas/keto-baking/1002/" },
            { "name": "Easy Dessert", "url": "/ideas/easy-dessert/1003/" },
            { "name": "Almond Flour", "url": "/ideas/almond-flour/1004/" },
            { "name": "Gluten Free", "url": "/ideas/gluten-free/1005/" },
            { "name": "Breakfast Ideas", "url": "/ideas/breakfast-ideas/1006/" }
          ]
        },
        "reactionCountsData": [
          { "reactionType": 1, "reactionCount": 20 }
        ],
        "totalReactionCount": 20
      }
    }
  }
});
</script>
</body>
</html>
  `;

  it('correctly extracts saves=265, repins=223, annotations.length=9, seo_category=Food And Drinks, canonical_pin_id=11822017768540414 from relay block', () => {
    const result = extractPinData(relayHtmlFixture, pinId);

    expect(result).not.toBeNull();
    expect(result!.saves).toBe(265);
    expect(result!.repins).toBe(223);
    expect(result!.annotations).toHaveLength(9);
    expect(result!.seo_category).toBe('Food And Drinks');
    expect(result!.canonical_pin_id).toBe('11822017768540414');
    expect(result!.share_count).toBe(8);
    expect(result!.follower_count).toBe(4500);
    expect(result!.board_id).toBe('999888777');
    expect(result!.seo_alt_text).toBe('Delicious gluten free keto bread');
  });

  it('returns null on empty or unparseable HTML without matching pinId', () => {
    const result = extractPinData('<html><body>No data here</body></html>', '999999999');
    expect(result).toBeNull();
  });
});
