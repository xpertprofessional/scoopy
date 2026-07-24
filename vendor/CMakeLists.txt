# Wizard's seam onto the vendored scoopy core (P1 plumbing, step 1).
#
# THIS FILE IS WRITABLE; everything under vendor/scoopy is NOT — it is
# hash-pinned by engine.lock.json and `apps/scoopy` is its only writable home
# until the P3 flip. That is exactly why this wrapper exists: registering the
# gates as ctest cases is a WIZARD concern, so it happens here instead of
# editing the vendored CMakeLists (which would show up as drift and fail
# `npm run engine:check`).
#
# scoopy's own engine/CMakeLists.txt is included verbatim. It builds the core,
# the C ABI (sl_engine) and its gate tools, and it was proven to build from
# this copy standalone before it was wired in here.

# The vendored tree deliberately does NOT inherit engine/'s strict flag set
# (-Werror -Wconversion -Wsign-conversion). Those are wizard's own law for
# wizard's own code; imposing them on a hash-pinned copy would mean the only
# way to fix a warning is to edit a file we are forbidden to edit. scoopy
# carries its own flags (-ffp-contract=off -Wall), including the one that is a
# CORRECTNESS requirement rather than taste: contraction off, so macOS and
# Linux take the same numeric path and can be null-tested against each other.
add_subdirectory(scoopy/engine)

# The DSP + ABI gates. scoopy runs these from scripts; wizard runs them from
# ctest so they cannot silently stop running — P1-KICKOFF §4 requires the
# scoopy null test and abi_fidelity_test to be standing gates before P2 can
# regress them. All ten pass on the vendored copy.
#
# scoopy_render_null is deliberately ABSENT: it is a dump tool, not a
# self-checking gate — its verdict comes from differencing two platforms'
# dumps (tools/null_test.py), which is a cross-platform job for CI, not a
# single-machine ctest case.
set(SCOOPY_GATES
    scoopy_denormal_test        # subnormals in the tails — invisible to the null test
    scoopy_filter_test          # magnitude response + modulation transient
    scoopy_clipper_test         # alias-vs-harmonic energy
    scoopy_headroom_test        # the real summing bus, driven too loud
    scoopy_choke_defer_test     # onset-aware cross-track choke
    scoopy_scene_switch_test    # sample-exact boundary install
    scoopy_rate_morph_test      # multiply glide lands back on the canonical grid
    scoopy_mute_immediacy_test  # mixer-true mute kills ringing audio
    scoopy_track_mix_level_test # per-track activity meter
    scoopy_abi_fidelity_test)   # the C ABI's own field loss, nothing else

foreach(gate IN LISTS SCOOPY_GATES)
    add_test(NAME ${gate} COMMAND ${gate})
endforeach()
