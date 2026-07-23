// Integration smoke for the vendored libsamplerate (P2-10a): proves it builds,
// links, and actually resamples — before the varispeed edit op is built on it.
#include <samplerate.h>

#include <cmath>
#include <cstddef>
#include <cstdio>
#include <cstring>
#include <vector>

#define CHECK(cond)                                                              \
    do {                                                                         \
        if (!(cond)) {                                                           \
            std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
            return 1;                                                            \
        }                                                                        \
    } while (0)

namespace {
constexpr double kPi = 3.14159265358979323846; // not M_PI (MSVC portability)
}

int main() {
    // Version string is present (linkage works).
    const char* ver = src_get_version();
    CHECK(ver != nullptr);
    CHECK(std::strstr(ver, "libsamplerate") != nullptr);

    // SINC_BEST_QUALITY is compiled in (D-05 needs it): a valid converter name.
    CHECK(src_get_name(SRC_SINC_BEST_QUALITY) != nullptr);

    // Resample a sine DOWN by 2x (ratio 0.5) with the best converter.
    const int inFrames = 2048;
    std::vector<float> in(static_cast<size_t>(inFrames));
    std::vector<float> out(static_cast<size_t>(inFrames)); // out <= inFrames*ratio
    for (size_t i = 0; i < in.size(); ++i)
        in[i] = static_cast<float>(0.5 * std::sin(2.0 * kPi * 40.0 *
                                                  static_cast<double>(i) / inFrames));

    SRC_DATA d;
    std::memset(&d, 0, sizeof(d));
    d.data_in = in.data();
    d.data_out = out.data();
    d.input_frames = inFrames;
    d.output_frames = inFrames;
    d.src_ratio = 0.5; // output frames ≈ 0.5 * input

    const int err = src_simple(&d, SRC_SINC_BEST_QUALITY, /*channels=*/1);
    CHECK(err == 0); // 0 = success
    CHECK(d.output_frames_gen > inFrames / 2 - 8); // ~1024 out
    CHECK(d.output_frames_gen < inFrames / 2 + 8);
    for (long i = 0; i < d.output_frames_gen; ++i)
        CHECK(std::isfinite(out[static_cast<size_t>(i)]));

    std::printf("libsamplerate_smoke OK (%s)\n", ver);
    return 0;
}
