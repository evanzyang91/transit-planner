import { type NextRequest, NextResponse} from 'next/server';

export async function GET(request: NextRequest) {
    const { searchParams } = new URL(request.url);
    const lat = searchParams.get('lat');
    const lng = searchParams.get('lng');
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;

    const size = searchParams.get('size') || '600x300';

    if (!lat || !lng) {
        return NextResponse.json({ error: 'Missing lat or lng parameters' }, { status: 400 });
    }

    if (!apiKey) {
        return new NextResponse(null, { status: 404 });
    }

    const url = `https://maps.googleapis.com/maps/api/streetview?size=${size}&location=${lat},${lng}&return_error_code=true&key=${apiKey}`;

    const response = await fetch(url);
    if (!response.ok) {
        return new NextResponse(null, { status: 404 });
    }
    const buffer = await response.arrayBuffer();

    return new NextResponse(buffer, {
        headers: {
            'Content-Type': 'image/jpeg',
        },
    });

}