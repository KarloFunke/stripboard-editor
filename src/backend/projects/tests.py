import json
import os

from django.contrib.auth.models import User
from django.test import Client, TestCase

from projects.migrations_data.ic_unification import (
    SCHEMA_VERSION,
    _X_NEW,
    _X_OLD,
    _apply_transform,
    _pin_offsets_for_def,
    _symbol_family,
    migrate_ic_unification,
)
from projects.models import Project


FIXTURE_PATH = os.path.join(os.path.dirname(__file__), "ic-migration-test-project.json")


def _v1_dip8_payload():
    """Small inline v1-shape payload: one DIP-8 with a wire on pin 1."""
    return {
        "components": [{
            "id": "c1", "defId": "def-ic-dip8",
            "schematicPos": {"x": 200, "y": 200},
            "schematicRotation": 0, "label": "U1",
            "boardPos": None, "rotation": 0,
        }],
        "schematicWires": [{
            "id": "w1",
            "start": {"x": 150, "y": 180},  # old DIP-8 pin1 abs
            "end": {"x": 500, "y": 180},
            "routeDirection": "horizontal-first",
        }],
    }


def _wire(sx, sy, ex, ey, wire_id="w"):
    return {
        "id": wire_id,
        "start": {"x": sx, "y": sy},
        "end": {"x": ex, "y": ey},
        "routeDirection": "horizontal-first",
    }


def _comp(comp_id, def_id, x, y, *, rotation=0, mirrored=False):
    return {
        "id": comp_id,
        "defId": def_id,
        "schematicPos": {"x": x, "y": y},
        "schematicRotation": rotation,
        "schematicMirrored": mirrored,
        "label": "U1",
        "boardPos": None,
        "rotation": 0,
    }


class IcUnificationTests(TestCase):
    # ── Affected ICs ────────────────────────────────────────

    def test_dip8_pin1_wire_repointed(self):
        # DIP-8 at (200, 200), no rotation.
        # pins_per_side=4, extent=60, y_start=-20.
        # Pin 1 (left, top): old local (-50, -20) → new (-60, -20).
        # Absolute: old (150, 180) → new (140, 180).
        data = {
            "components": [_comp("c1", "def-ic-dip8", 200, 200)],
            "schematicWires": [_wire(150, 180, 500, 180)],
        }
        out, changed = migrate_ic_unification(data)
        self.assertTrue(changed)
        self.assertEqual(out["schematicWires"][0]["start"], {"x": 140, "y": 180})
        self.assertEqual(out["schematicWires"][0]["end"], {"x": 500, "y": 180})
        self.assertEqual(out["version"], SCHEMA_VERSION)

    def test_dip8_all_eight_pins(self):
        # Verify the full pin layout for DIP-8.
        # Left (x=-old, y=[-20,0,20,40]); Right (x=+old, y=[40,20,0,-20]).
        c = _comp("c1", "def-ic-dip8", 200, 200)
        wires = []
        for y in (-20, 0, 20, 40):
            wires.append(_wire(200 - 50, 200 + y, 999, 999, wire_id=f"L{y}"))
            wires.append(_wire(200 + 50, 200 + y, 999, 999, wire_id=f"R{y}"))
        data = {"components": [c], "schematicWires": wires}
        out, _ = migrate_ic_unification(data)
        # Every wire start should now sit at the new ±60 x position; ends untouched.
        for w in out["schematicWires"]:
            self.assertIn(w["start"]["x"], (140, 260))
            self.assertEqual(w["end"], {"x": 999, "y": 999})

    def test_555_rotated_90(self):
        # 555 pin 1 local (old): (-40, -20). Rotate 90°: (-y, x) = (20, -40).
        # 555 pin 1 local (new): (-60, -20). Rotate 90°: (20, -60).
        # At (100, 100): old abs (120, 60) → new abs (120, 40).
        data = {
            "components": [_comp("c1", "def-555", 100, 100, rotation=90)],
            "schematicWires": [_wire(120, 60, 999, 999)],
        }
        out, _ = migrate_ic_unification(data)
        self.assertEqual(out["schematicWires"][0]["start"], {"x": 120, "y": 40})

    def test_555_mirrored(self):
        # 555 pin 1 local (old): (-40, -20). Mirror: (40, -20). Rotate 0: (40, -20).
        # 555 pin 1 local (new): (-60, -20). Mirror: (60, -20).
        # At (50, 50): old abs (90, 30) → new abs (110, 30).
        data = {
            "components": [_comp("c1", "def-555", 50, 50, mirrored=True)],
            "schematicWires": [_wire(999, 999, 90, 30)],
        }
        out, _ = migrate_ic_unification(data)
        self.assertEqual(out["schematicWires"][0]["end"], {"x": 110, "y": 30})

    def test_optocoupler_unrelated_wires_untouched(self):
        # Opto at (300, 300). Pin 1 old local (-40, -20) → abs (260, 280).
        # Wire at (200, 200) → (250, 250): neither endpoint matches any pin.
        data = {
            "components": [_comp("c1", "def-optocoupler", 300, 300)],
            "schematicWires": [_wire(200, 200, 250, 250)],
        }
        out, _ = migrate_ic_unification(data)
        self.assertEqual(out["schematicWires"][0]["start"], {"x": 200, "y": 200})
        self.assertEqual(out["schematicWires"][0]["end"], {"x": 250, "y": 250})

    # ── Non-affected components ─────────────────────────────

    def test_resistor_wire_untouched(self):
        # Resistor is not in DEFAULT_IC_SYMBOLS.
        data = {
            "components": [_comp("r1", "def-resistor", 100, 100)],
            "schematicWires": [_wire(100, 80, 100, 120)],
        }
        out, _ = migrate_ic_unification(data)
        self.assertEqual(out["schematicWires"][0]["start"], {"x": 100, "y": 80})
        self.assertEqual(out["schematicWires"][0]["end"], {"x": 100, "y": 120})

    def test_resistor_at_old_ic_pin_position_unaffected(self):
        # Two components: a DIP-8 IC (will trigger remap at (150, 180))
        # and a resistor whose wire HAPPENS to terminate elsewhere.
        # Confirms we only build remap entries from affected IC components.
        data = {
            "components": [_comp("r1", "def-resistor", 999, 999)],
            "schematicWires": [_wire(150, 180, 200, 200)],
        }
        out, _ = migrate_ic_unification(data)
        # No IC in the project → no remap → wire untouched.
        self.assertEqual(out["schematicWires"][0]["start"], {"x": 150, "y": 180})

    # ── Idempotency & shape edge cases ──────────────────────

    def test_idempotent_v2_data(self):
        data = {
            "version": 2,
            "components": [_comp("c1", "def-ic-dip8", 200, 200)],
            "schematicWires": [_wire(150, 180, 500, 180)],
        }
        out, changed = migrate_ic_unification(data)
        self.assertFalse(changed)
        # No mutation.
        self.assertEqual(out["schematicWires"][0]["start"], {"x": 150, "y": 180})
        self.assertEqual(out["version"], 2)

    def test_missing_components_key(self):
        data = {"schematicWires": []}
        out, changed = migrate_ic_unification(data)
        self.assertTrue(changed)
        self.assertEqual(out["version"], SCHEMA_VERSION)

    def test_missing_wires_key(self):
        data = {"components": [_comp("c1", "def-ic-dip8", 200, 200)]}
        out, changed = migrate_ic_unification(data)
        self.assertTrue(changed)
        self.assertEqual(out["version"], SCHEMA_VERSION)

    def test_non_dict_data(self):
        out, changed = migrate_ic_unification("not a dict")
        self.assertFalse(changed)
        self.assertEqual(out, "not a dict")

    def test_null_schematic_pos_skipped(self):
        # Component with no schematicPos is skipped silently; version still stamped.
        comp = _comp("c1", "def-ic-dip8", 200, 200)
        comp["schematicPos"] = None
        data = {
            "components": [comp],
            "schematicWires": [_wire(150, 180, 500, 180)],
        }
        out, changed = migrate_ic_unification(data)
        self.assertTrue(changed)
        self.assertEqual(out["version"], SCHEMA_VERSION)
        # Wire shouldn't have moved (no remap entry for this component).
        self.assertEqual(out["schematicWires"][0]["start"], {"x": 150, "y": 180})

    def test_empty_project(self):
        data = {}
        out, changed = migrate_ic_unification(data)
        self.assertTrue(changed)
        self.assertEqual(out["version"], SCHEMA_VERSION)


class IcUnificationRealWorldTests(TestCase):
    """End-to-end tests against a real exported project, hand-built on the
    pre-migration live site. The fixture exercises all 3 affected IC families
    (generic-ic-N, timer-555, optocoupler) across every rotation (0/90/180/270)
    and both mirror states, with many wires connecting to every pin."""

    FIXTURE = os.path.join(
        os.path.dirname(__file__), "ic-migration-test-project.json"
    )

    def _load(self):
        with open(self.FIXTURE) as f:
            return json.load(f)

    def _pin_remap(self, project):
        """Build (round(old_abs)) -> new_abs from every affected IC component."""
        remap = {}
        for comp in project.get("components", []):
            family = _symbol_family(comp.get("defId", ""))
            offsets = _pin_offsets_for_def(comp.get("defId", ""))
            if family is None or not offsets:
                continue
            cx = comp["schematicPos"]["x"]
            cy = comp["schematicPos"]["y"]
            rotation = comp.get("schematicRotation", 0)
            mirrored = bool(comp.get("schematicMirrored"))
            old_mag = _X_OLD[family]
            new_mag = _X_NEW[family]
            for x_sign, y in offsets:
                ox, oy = _apply_transform(x_sign * old_mag, y, rotation, mirrored)
                nx, ny = _apply_transform(x_sign * new_mag, y, rotation, mirrored)
                remap[(round(cx + ox), round(cy + oy))] = (cx + nx, cy + ny)
        return remap

    def test_real_project_wires_relocate_correctly(self):
        data = self._load()

        # Build expected post-migration wire layout up front: each endpoint
        # either matches an old IC pin (and gets the new position) or stays put.
        pin_remap = self._pin_remap(data)
        expected = []
        for wire in data["schematicWires"]:
            row = {"id": wire["id"]}
            for endpoint in ("start", "end"):
                p = wire[endpoint]
                key = (round(p["x"]), round(p["y"]))
                row[endpoint] = pin_remap.get(key, (p["x"], p["y"]))
            expected.append(row)

        # Sanity: the fixture wires many pins across every rotation/mirror.
        moved = sum(
            1 for w, e in zip(data["schematicWires"], expected)
            if (w["start"]["x"], w["start"]["y"]) != e["start"]
            or (w["end"]["x"], w["end"]["y"]) != e["end"]
        )
        self.assertGreater(moved, 50, "fixture should have many IC-connected wires")

        out, changed = migrate_ic_unification(data)
        self.assertTrue(changed)
        self.assertEqual(out["version"], SCHEMA_VERSION)
        self.assertEqual(len(out["schematicWires"]), len(expected))

        for w, exp in zip(out["schematicWires"], expected):
            self.assertEqual(
                (w["start"]["x"], w["start"]["y"]), exp["start"],
                f"wire {w['id']}.start: expected {exp['start']}, "
                f"got ({w['start']['x']}, {w['start']['y']})",
            )
            self.assertEqual(
                (w["end"]["x"], w["end"]["y"]), exp["end"],
                f"wire {w['id']}.end: expected {exp['end']}, "
                f"got ({w['end']['x']}, {w['end']['y']})",
            )

    def test_real_project_no_wire_left_at_old_ic_pin(self):
        """Post-migration invariant: no wire endpoint should still sit at one of
        the (now-stale) old IC pin positions. Catches partial-migration bugs."""
        data = self._load()
        old_positions = set(self._pin_remap(data).keys())

        out, _ = migrate_ic_unification(data)

        for w in out["schematicWires"]:
            for endpoint in ("start", "end"):
                p = w[endpoint]
                self.assertNotIn(
                    (round(p["x"]), round(p["y"])),
                    old_positions,
                    f"wire {w['id']}.{endpoint} still at old IC pin position "
                    f"({p['x']}, {p['y']}) after migration",
                )

    def test_real_project_idempotent(self):
        """Running the migration twice should be a no-op the second time."""
        data = self._load()
        migrate_ic_unification(data)
        snapshot = json.dumps(data, sort_keys=True)

        _, changed = migrate_ic_unification(data)
        self.assertFalse(changed)
        self.assertEqual(json.dumps(data, sort_keys=True), snapshot)


class ProjectMigrateEndpointTests(TestCase):
    """The POST /api/projects/migrate/ endpoint: stateless, no DB I/O.
    Used by the frontend when importing a JSON file on an older schema."""

    def test_returns_migrated_data(self):
        payload = {
            "components": [{
                "id": "c1", "defId": "def-ic-dip8",
                "schematicPos": {"x": 200, "y": 200},
                "schematicRotation": 0, "label": "U1",
                "boardPos": None, "rotation": 0,
            }],
            "schematicWires": [{
                "id": "w1",
                "start": {"x": 150, "y": 180},  # old DIP-8 pin1 abs
                "end": {"x": 500, "y": 180},
                "routeDirection": "horizontal-first",
            }],
        }
        res = Client().post(
            "/api/projects/migrate/",
            data=json.dumps(payload),
            content_type="application/json",
        )
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertEqual(body["version"], SCHEMA_VERSION)
        self.assertEqual(body["schematicWires"][0]["start"], {"x": 140, "y": 180})

    def test_rejects_non_object(self):
        res = Client().post(
            "/api/projects/migrate/",
            data=json.dumps([1, 2, 3]),
            content_type="application/json",
        )
        self.assertEqual(res.status_code, 400)

    def test_already_v2_data_passes_through_unchanged(self):
        payload = {"version": 2, "components": [], "schematicWires": []}
        res = Client().post(
            "/api/projects/migrate/",
            data=json.dumps(payload),
            content_type="application/json",
        )
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json(), payload)


class SaveHookRouteTests(TestCase):
    """PUT /api/projects/<edit_uuid>/ must run the migration through the
    serializer and persist v2 data to the DB."""

    def setUp(self):
        # Seed directly via the ORM so we can put v1-shaped data in the DB
        # without going through any endpoint.
        self.project = Project.objects.create(name="Test", data=_v1_dip8_payload())

    def test_put_v1_payload_migrates_and_persists(self):
        res = Client().put(
            f"/api/projects/{self.project.edit_uuid}/",
            data=json.dumps({"name": "Test", "data": _v1_dip8_payload()}),
            content_type="application/json",
        )
        self.assertEqual(res.status_code, 200)
        # Response carries migrated data...
        body = res.json()
        self.assertEqual(body["data"]["version"], SCHEMA_VERSION)
        self.assertEqual(body["data"]["schematicWires"][0]["start"], {"x": 140, "y": 180})
        # ...and the DB row matches.
        self.project.refresh_from_db()
        self.assertEqual(self.project.data["version"], SCHEMA_VERSION)
        self.assertEqual(self.project.data["schematicWires"][0]["start"], {"x": 140, "y": 180})

    def test_put_v2_payload_unchanged(self):
        payload = {"version": 2, "components": [], "schematicWires": []}
        res = Client().put(
            f"/api/projects/{self.project.edit_uuid}/",
            data=json.dumps({"name": "Test", "data": payload}),
            content_type="application/json",
        )
        self.assertEqual(res.status_code, 200)
        self.project.refresh_from_db()
        self.assertEqual(self.project.data, payload)

    def test_put_full_fixture_round_trip(self):
        """End-to-end with the comprehensive fixture: PUT v1 data, get v2 back,
        verify a sample of pin endpoints moved correctly."""
        with open(FIXTURE_PATH) as f:
            fixture = json.load(f)
        res = Client().put(
            f"/api/projects/{self.project.edit_uuid}/",
            data=json.dumps({"name": "Fixture", "data": fixture}),
            content_type="application/json",
        )
        self.assertEqual(res.status_code, 200)
        self.project.refresh_from_db()
        self.assertEqual(self.project.data["version"], SCHEMA_VERSION)
        # No wire should still sit at one of the OLD IC pin positions.
        # (Reuses the same invariant as IcUnificationRealWorldTests.)
        old_positions = set()
        for comp in fixture["components"]:
            family = _symbol_family(comp.get("defId", ""))
            offsets = _pin_offsets_for_def(comp.get("defId", ""))
            if family is None or not offsets:
                continue
            cx, cy = comp["schematicPos"]["x"], comp["schematicPos"]["y"]
            rotation = comp.get("schematicRotation", 0)
            mirrored = bool(comp.get("schematicMirrored"))
            for x_sign, y in offsets:
                ox, oy = _apply_transform(x_sign * _X_OLD[family], y, rotation, mirrored)
                old_positions.add((round(cx + ox), round(cy + oy)))
        for w in self.project.data["schematicWires"]:
            for endpoint in ("start", "end"):
                p = w[endpoint]
                self.assertNotIn((round(p["x"]), round(p["y"])), old_positions)

    def test_put_oversize_payload_rejected(self):
        """The size cap that validate_data enforces — payload larger than 1MB
        must 400, regardless of version."""
        oversize = {"version": 2, "components": [], "schematicWires": [],
                    "padding": "x" * 1_100_000}
        res = Client().put(
            f"/api/projects/{self.project.edit_uuid}/",
            data=json.dumps({"name": "Test", "data": oversize}),
            content_type="application/json",
        )
        self.assertEqual(res.status_code, 400)


class CreateHookRouteTests(TestCase):
    """POST /api/projects/ must run the migration through the serializer.
    Authenticated to skip the PoW gate."""

    def setUp(self):
        self.user = User.objects.create_user("testuser", password="x" * 64)
        self.client = Client()
        self.client.force_login(self.user)

    def test_post_v1_payload_creates_as_v2(self):
        res = self.client.post(
            "/api/projects/",
            data=json.dumps({"name": "New", "data": _v1_dip8_payload()}),
            content_type="application/json",
        )
        self.assertEqual(res.status_code, 201)
        project = Project.objects.get(edit_uuid=res.json()["edit_uuid"])
        self.assertEqual(project.data["version"], SCHEMA_VERSION)
        self.assertEqual(project.data["schematicWires"][0]["start"], {"x": 140, "y": 180})

    def test_post_v2_payload_unchanged(self):
        payload = {"version": 2, "components": [], "schematicWires": []}
        res = self.client.post(
            "/api/projects/",
            data=json.dumps({"name": "New", "data": payload}),
            content_type="application/json",
        )
        self.assertEqual(res.status_code, 201)
        project = Project.objects.get(edit_uuid=res.json()["edit_uuid"])
        self.assertEqual(project.data, payload)
