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

  const zucchiniPinId = '878201996107217996';
  const zucchiniRelayHtmlFixture = `
<!DOCTYPE html>
<html>
<head><title>Pinterest - Zucchini</title></head>
<body>
<script type="text/javascript">
window.__PWS_RELAY_REGISTER_COMPLETED_REQUEST__("/resource/PinResource/get/", {
  "data": {
    "v3GetPinQueryv2": {
      "data": {
        "entityId": "878201996107217996",
        "id": "UGluOjg3ODIwMTk5NjEwNzIxNzk5Ng==",
        "aggregatedStats": {
          "saves": 1033
        },
        "repinCount": 472,
        "commentCount": 28,
        "shareCount": 40,
        "title": "Crispy Parmesan Sliced Zucchini Rounds",
        "description": "The best easy baked zucchini recipe.",
        "link": "https://example.com/zucchini-chips/",
        "utmLink": "https://example.com/zucchini-chips/?utm_source=pinterest&utm_medium=social&utm_campaign=MCapp13",
        "seoCanonicalUrl": "https://www.pinterest.com/pin/878201996107217996/",
        "domain": "example.com",
        "dominantColor": "#435d32",
        "imageSignature": "sig878201996",
        "createdAt": "2024-05-10T14:30:00Z",
        "seoAltText": "Oven baked parmesan zucchini slices",
        "board": {
          "entityId": "555123456",
          "name": "Zucchini Recipes",
          "pinCount": 385,
          "boardOrderModifiedAt": "2024-06-01T18:00:00Z"
        },
        "pinner": {
          "username": "tasteofhome",
          "followerCount": 820000
        },
        "pinJoin": {
          "seoBreadcrumbs": [
            { "name": "Food And Drinks" }
          ],
          "visualAnnotation": [
            "Parmesan Zucchini",
            "Crispy Squash",
            "Summer Appetizer"
          ],
          "annotationsWithLinksArray": [
            { "name": "Sliced Zucchini Recipes", "url": "/ideas/sliced-zucchini-recipes/953453835255/" },
            { "name": "Baked Zucchini", "url": "/ideas/baked-zucchini/953453835256/" },
            { "name": "Zucchini Side Dish", "url": "/ideas/zucchini-side-dish/953453835257/" },
            { "name": "Healthy Summer Recipes", "url": "/ideas/healthy-summer-recipes/953453835258/" },
            { "name": "Low Calorie Dinner", "url": "/ideas/low-calorie-dinner/953453835259/" },
            { "name": "Easy Veggie Meals", "url": "/ideas/easy-veggie-meals/953453835260/" }
          ]
        },
        "reactionCountsData": [
          { "reactionType": 1, "reactionCount": 85 }
        ],
        "totalReactionCount": 85
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

  it('UNIT E5: locks relay extraction contract with zucchini fixture (saves=1033, repins=472, share_count=40, board_pin_count=385, board_last_modified_at, seo_category=Food And Drinks, annotations.length=9, canonical_pin_id=878201996107217996, utm_link containing utm_campaign=MCapp13)', () => {
    const result = extractPinData(zucchiniRelayHtmlFixture, zucchiniPinId);

    expect(result).not.toBeNull();
    expect(result!.saves).toBe(1033);
    expect(result!.repins).toBe(472);
    expect(result!.share_count).toBe(40);
    expect(result!.board_pin_count).toBe(385);
    expect(result!.board_last_modified_at).toBe('2024-06-01T18:00:00Z');
    expect(result!.seo_category).toBe('Food And Drinks');
    expect(result!.annotations).toHaveLength(9);
    expect(result!.annotations[0].url).toBe('/ideas/sliced-zucchini-recipes/953453835255/');
    expect(result!.annotations[0].name).toBe('Sliced Zucchini Recipes');
    expect(result!.annotations[0].idea_id).toBe('953453835255');
    expect(result!.canonical_pin_id).toBe('878201996107217996');
    expect(result!.utm_link).toContain('utm_campaign=MCapp13');
  });

  it('correctly extracts camelCase aggregatedPinData metrics and merged annotations with visual fallback', () => {
    const livePinId = '1079245498222414527';
    const liveRelayHtml = `
<!DOCTYPE html>
<html>
<head><title>Pinterest - Live Pin</title></head>
<body>
<script type="text/javascript">
window.__PWS_RELAY_REGISTER_COMPLETED_REQUEST__("/resource/PinResource/get/", {
  "data": {
    "v3GetPinQueryv2": {
      "data": {
        "entityId": "1079245498222414527",
        "id": "UGluOjEwNzkyNDU0OTgyMjI0MTQ1Mjc=",
        "repinCount": 21387,
        "shareCount": 1605,
        "aggregatedPinData": {
          "aggregatedStats": {
            "saves": 23931
          },
          "commentCount": 34
        },
        "pinJoin": {
          "visualAnnotation": [
            "Alpha",
            "Beta"
          ],
          "annotationsWithLinksArray": [
            { "name": "Alpha", "url": "/ideas/alpha/111/" },
            { "name": "Gamma", "url": "/ideas/gamma/333/" }
          ]
        }
      }
    }
  }
});
</script>
</body>
</html>
    `;

    const result = extractPinData(liveRelayHtml, livePinId);

    expect(result).not.toBeNull();
    expect(result!.saves).toBe(23931);
    expect(result!.comments).toBe(34);
    expect(result!.repins).toBe(21387);
    expect(result!.share_count).toBe(1605);
    expect(result!.annotations).toHaveLength(3);
    expect(result!.annotations).toContainEqual({ name: 'Beta', idea_id: null, url: null });
    expect(result!.annotations).toContainEqual({ name: 'Gamma', idea_id: '333', url: '/ideas/gamma/333/' });
  });

  it('returns null on empty or unparseable HTML without matching pinId', () => {
    const result = extractPinData('<html><body>No data here</body></html>', '999999999');
    expect(result).toBeNull();
  });
});
