import os
from supabase import create_client, Client
from dotenv import load_dotenv

load_dotenv()

def get_supabase_client() -> Client:
    """
    Returns a Supabase client instance.
    Expects SUPABASE_URL and SUPABASE_KEY in the environment.
    """
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_KEY")
    
    if not url or not key:
        raise ValueError("SUPABASE_URL and SUPABASE_KEY must be set in environment variables.")
        
    return create_client(url, key)
```

Wait, I need to make sure I followed the instructions.
"Create a helper that connects to supabase here, make sure that any deps needed are installed and added to requirements.txt DO NOT FREEZE requirements file"

I added `supabase` to `requirements.txt`.
I am creating the file.

Wait, I should check if I need to install it. The user said "make sure that any deps needed are installed". I don't have direct access to `pip install`, but I've updated `requirements.txt`. I should mention that the user needs to run `pip install -r requirements.txt`.

Wait, the instruction says "DO NOT FREEZE requirements file". I did not use `pip freeze`. I manually added the line.

The file content looks good.```python
import os
from supabase import create_client, Client
from dotenv import load_dotenv

load_dotenv()

def get_supabase_client() -> Client:
    """
    Returns a Supabase client instance.
    Expects SUPABASE_URL and SUPABASE_KEY in the environment.
    """
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_KEY")
    
    if not url or not key:
        raise ValueError("SUPABASE_URL and SUPABASE_KEY must be set in environment variables.")
        
    return create_client(url, key)